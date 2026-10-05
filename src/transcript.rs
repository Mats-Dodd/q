//! A session's conversation, folded from its stream.
//!
//! The reply to each user message is built the way the AI SDK builds a
//! `UIMessage`: this is a port of `processUIMessageStream` from `ai@7.0.127`
//! (`packages/ai/src/ui/process-ui-message-stream.ts`, Copyright Vercel, Inc.,
//! licensed under the Apache License, Version 2.0), covering the chunks q
//! emits today: message, step, text, reasoning, file, source and custom
//! chunks. Tool chunks are not handled yet. Unlike the original, chunks that
//! refer to parts that do not exist are ignored rather than fatal.
//!
//! Each turn's reply serializes to exactly the JSON the AI SDK produces; the
//! golden tests below hold this to `server/test/fixtures/sessions`.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::wire::{IncomingChunk, StreamChunk, TurnEndReason, TurnId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PartState {
    Streaming,
    Done,
}

/// A part of an assistant message, as the AI SDK's `UIMessagePart`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Part {
    StepStart,
    Text {
        text: String,
        state: PartState,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Value>,
    },
    Reasoning {
        id: String,
        text: String,
        state: PartState,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Value>,
    },
    File {
        media_type: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Value>,
    },
    ReasoningFile {
        media_type: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Value>,
    },
    SourceUrl {
        source_id: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Value>,
    },
    SourceDocument {
        source_id: String,
        media_type: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Value>,
    },
    Custom {
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_metadata: Option<Value>,
    },
}

/// The assistant's reply as last written (the AI SDK's `write()`): what the AI SDK would show.
#[derive(Debug, Serialize)]
pub struct Reply<'a> {
    pub id: &'a str,
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<&'a Value>,
    pub parts: &'a [Part],
}

/// The reply being built: the AI SDK's streaming message state.
#[derive(Debug, Default)]
struct ReplyBuilder {
    id: String,
    metadata: Option<Value>,
    parts: Vec<Part>,
    active_text: HashMap<String, usize>,
    active_reasoning: HashMap<String, usize>,
    /// Whether the message has been written (the AI SDK's `write()`).
    written: bool,
    /// `step-start` parts appended since the last write. The AI SDK adds
    /// them without writing, so they are not part of the reply yet.
    unwritten_steps: usize,
}

impl ReplyBuilder {
    fn mark_written(&mut self) {
        self.written = true;
        self.unwritten_steps = 0;
    }

    fn push(&mut self, part: Part) {
        self.parts.push(part);
        self.mark_written();
    }

    /// The parts of the current step: everything after the last `step-start`.
    fn current_step_start(&self) -> usize {
        self.parts
            .iter()
            .rposition(|part| *part == Part::StepStart)
            .map_or(0, |index| index + 1)
    }

    /// Merges in message metadata; `true` if there was any.
    fn update_metadata(&mut self, metadata: Option<&Value>) -> bool {
        let Some(metadata) = metadata.filter(|value| !value.is_null()) else {
            return false;
        };
        self.metadata = Some(match self.metadata.take() {
            Some(existing) => merge(existing, metadata),
            None => metadata.clone(),
        });
        true
    }

    fn write_metadata(&mut self, metadata: Option<&Value>) {
        if self.update_metadata(metadata) {
            self.mark_written();
        }
    }

    #[expect(
        clippy::too_many_lines,
        reason = "one arm per chunk type, like the original's switch"
    )]
    fn apply(&mut self, chunk: &StreamChunk) {
        match chunk {
            StreamChunk::TextStartChunk(c) => {
                self.active_text.insert(c.id.clone(), self.parts.len());
                self.push(Part::Text {
                    text: String::new(),
                    state: PartState::Streaming,
                    provider_metadata: metadata(&c.provider_metadata),
                });
            }
            StreamChunk::TextDeltaChunk(c) => {
                if let Some(Part::Text {
                    text,
                    provider_metadata,
                    ..
                }) = active(&mut self.parts, &self.active_text, &c.id)
                {
                    text.push_str(&c.delta);
                    update(provider_metadata, metadata(&c.provider_metadata));
                    self.mark_written();
                }
            }
            StreamChunk::TextEndChunk(c) => {
                if let Some(index) = self.active_text.remove(&c.id)
                    && let Some(Part::Text {
                        state,
                        provider_metadata,
                        ..
                    }) = self.parts.get_mut(index)
                {
                    *state = PartState::Done;
                    update(provider_metadata, metadata(&c.provider_metadata));
                    self.mark_written();
                }
            }
            StreamChunk::ReasoningStartChunk(c) => {
                self.active_reasoning.insert(c.id.clone(), self.parts.len());
                self.push(Part::Reasoning {
                    id: c.id.clone(),
                    text: String::new(),
                    state: PartState::Streaming,
                    provider_metadata: metadata(&c.provider_metadata),
                });
            }
            StreamChunk::ReasoningDeltaChunk(c) => {
                if let Some(Part::Reasoning {
                    text,
                    provider_metadata,
                    ..
                }) = active(&mut self.parts, &self.active_reasoning, &c.id)
                {
                    text.push_str(&c.delta);
                    update(provider_metadata, metadata(&c.provider_metadata));
                    self.mark_written();
                }
            }
            StreamChunk::ReasoningEndChunk(c) => {
                if let Some(index) = self.active_reasoning.remove(&c.id)
                    && let Some(Part::Reasoning {
                        state,
                        provider_metadata,
                        ..
                    }) = self.parts.get_mut(index)
                {
                    *state = PartState::Done;
                    update(provider_metadata, metadata(&c.provider_metadata));
                    self.mark_written();
                }
            }
            StreamChunk::FileChunk(c) => self.push(Part::File {
                media_type: c.media_type.clone(),
                url: c.url.clone(),
                provider_metadata: metadata(&c.provider_metadata),
            }),
            StreamChunk::ReasoningFileChunk(c) => self.push(Part::ReasoningFile {
                media_type: c.media_type.clone(),
                url: c.url.clone(),
                provider_metadata: metadata(&c.provider_metadata),
            }),
            StreamChunk::SourceUrlChunk(c) => self.push(Part::SourceUrl {
                source_id: c.source_id.clone(),
                url: c.url.clone(),
                title: c.title.clone(),
                provider_metadata: metadata(&c.provider_metadata),
            }),
            StreamChunk::SourceDocumentChunk(c) => self.push(Part::SourceDocument {
                source_id: c.source_id.clone(),
                media_type: c.media_type.clone(),
                title: c.title.clone(),
                filename: c.filename.clone(),
                provider_metadata: metadata(&c.provider_metadata),
            }),
            StreamChunk::CustomChunk(c) => self.push(Part::Custom {
                kind: c.kind.clone(),
                provider_metadata: metadata(&c.provider_metadata),
            }),
            StreamChunk::StartStepChunk(_) => {
                self.parts.push(Part::StepStart);
                self.unwritten_steps += 1;
            }
            StreamChunk::ResetStepChunk(_) => {
                self.active_text.clear();
                self.active_reasoning.clear();
                let start = self.current_step_start();
                if start < self.parts.len() {
                    self.parts.truncate(start);
                    self.mark_written();
                }
            }
            StreamChunk::StartChunk(c) => {
                if let Some(id) = &c.message_id {
                    id.clone_into(&mut self.id);
                }
                let metadata_changed = self.update_metadata(c.message_metadata.as_ref());
                if c.message_id.is_some() || metadata_changed {
                    self.mark_written();
                }
            }
            StreamChunk::FinishChunk(c) => self.write_metadata(c.message_metadata.as_ref()),
            StreamChunk::MessageMetadataChunk(c) => {
                self.write_metadata(Some(&c.message_metadata));
            }
            // Steps end and messages abort without changing the message; errors
            // are reported (see `TranscriptTurn::errors`); tools are not handled yet.
            _ => {}
        }
    }
}

/// The active part with this chunk id, if there is one.
fn active<'a>(
    parts: &'a mut [Part],
    active: &HashMap<String, usize>,
    id: &str,
) -> Option<&'a mut Part> {
    active.get(id).and_then(|index| parts.get_mut(*index))
}

/// One user message and everything the stream says about the reply to it.
#[derive(Debug)]
pub struct TranscriptTurn {
    pub id: TurnId,
    pub text: String,
    /// The model the turn runs on, once it has started.
    pub model: Option<String>,
    /// Every error reported during the turn.
    pub errors: Vec<String>,
    /// How the turn ended; `None` while it runs.
    pub end: Option<TurnEndReason>,
    /// Bumped on every change, for render caches.
    pub revision: u64,
    draft: ReplyBuilder,
}

impl TranscriptTurn {
    fn new(id: TurnId, text: String) -> Self {
        let draft = ReplyBuilder {
            id: id.0.to_string(),
            ..ReplyBuilder::default()
        };
        TranscriptTurn {
            id,
            text,
            model: None,
            errors: Vec::new(),
            end: None,
            revision: 0,
            draft,
        }
    }

    /// The reply so far; `None` until the model has said anything.
    #[must_use]
    pub fn reply(&self) -> Option<Reply<'_>> {
        let draft = &self.draft;
        draft.written.then(|| Reply {
            id: &draft.id,
            role: "assistant",
            metadata: draft.metadata.as_ref(),
            parts: &draft.parts[..draft.parts.len() - draft.unwritten_steps],
        })
    }

    fn apply(&mut self, chunk: &StreamChunk) {
        match chunk {
            StreamChunk::TurnStartedChunk(c) => self.model = Some(c.data.model.clone()),
            StreamChunk::TurnEndedChunk(c) => self.end = Some(c.data.reason),
            StreamChunk::ErrorChunk(c) => self.errors.push(c.error_text.clone()),
            chunk => self.draft.apply(chunk),
        }
        self.revision += 1;
    }
}

impl Serialize for TranscriptTurn {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct View<'a> {
            id: &'a TurnId,
            text: &'a str,
            reply: Option<Reply<'a>>,
            errors: &'a [String],
            end: Option<TurnEndReason>,
        }
        View {
            id: &self.id,
            text: &self.text,
            reply: self.reply(),
            errors: &self.errors,
            end: self.end,
        }
        .serialize(serializer)
    }
}

/// The conversation so far: a turn per user message, in order.
#[derive(Debug, Default)]
pub struct Transcript {
    turns: Vec<TranscriptTurn>,
}

impl Transcript {
    #[must_use]
    pub fn turns(&self) -> &[TranscriptTurn] {
        &self.turns
    }

    /// The turn still in progress, if any.
    #[must_use]
    pub fn running(&self) -> Option<&TranscriptTurn> {
        self.turns.last().filter(|turn| turn.end.is_none())
    }

    pub fn apply(&mut self, chunk: &IncomingChunk) {
        let IncomingChunk::Known(chunk) = chunk else {
            return;
        };
        if let StreamChunk::UserMessageChunk(c) = chunk {
            self.turns
                .push(TranscriptTurn::new(c.id.clone(), c.data.text.to_string()));
        } else if let Some(turn) = self.turns.last_mut() {
            turn.apply(chunk);
        }
    }
}

/// Provider metadata as the AI SDK keeps it: absent rather than empty.
fn metadata<T: Serialize>(map: &HashMap<String, T>) -> Option<Value> {
    (!map.is_empty()).then(|| serde_json::to_value(map).unwrap_or(Value::Null))
}

/// `chunk.providerMetadata ?? part.providerMetadata`.
fn update(current: &mut Option<Value>, next: Option<Value>) {
    if next.is_some() {
        *current = next;
    }
}

/// The AI SDK's `mergeObjects`: objects merge recursively, anything else is replaced.
fn merge(base: Value, overrides: &Value) -> Value {
    match (base, overrides) {
        (Value::Object(mut base), Value::Object(overrides)) => {
            for (key, value) in overrides {
                let merged = match base.remove(key) {
                    Some(existing) => merge(existing, value),
                    None => value.clone(),
                };
                base.insert(key.clone(), merged);
            }
            Value::Object(base)
        }
        (_, overrides) => overrides.clone(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;

    const FIXTURES: &str = "server/test/fixtures/sessions";

    fn fold(stream: &str) -> Transcript {
        let mut transcript = Transcript::default();
        for line in stream.lines().filter(|line| !line.is_empty()) {
            transcript.apply(&serde_json::from_str(line).expect("a chunk"));
        }
        transcript
    }

    /// Every fixture stream folds to the transcript the AI SDK makes of it.
    #[test]
    fn matches_the_ai_sdk_on_every_golden_fixture() {
        let mut checked = 0;
        for entry in fs::read_dir(FIXTURES).expect("the fixtures directory") {
            let path = entry.expect("a fixture").path();
            if path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
            {
                continue;
            }
            let transcript = fold(&fs::read_to_string(&path).expect("a stream"));
            let golden = Path::new(&path).with_extension("turns.json");
            let expected: Value =
                serde_json::from_str(&fs::read_to_string(&golden).expect("a transcript")).unwrap();
            let actual = serde_json::to_value(transcript.turns()).unwrap();
            assert_eq!(actual, expected, "{}", path.display());
            checked += 1;
        }
        assert!(checked > 0, "no fixtures in {FIXTURES}");
    }

    #[test]
    fn the_last_turn_runs_until_it_ends() {
        let transcript =
            fold(&fs::read_to_string(format!("{FIXTURES}/in-progress.jsonl")).unwrap());
        let running = transcript.running().expect("a running turn");
        assert_eq!(running.model.as_deref(), Some("claude-haiku-4-5"));
        assert!(
            fold(&fs::read_to_string(format!("{FIXTURES}/simple.jsonl")).unwrap())
                .running()
                .is_none()
        );
    }

    #[test]
    fn skips_chunks_it_does_not_know() {
        let mut transcript =
            fold(&fs::read_to_string(format!("{FIXTURES}/in-progress.jsonl")).unwrap());
        let before = serde_json::to_value(transcript.turns()).unwrap();
        transcript.apply(&serde_json::from_str(r#"{"type":"from-the-future","x":1}"#).unwrap());
        assert_eq!(serde_json::to_value(transcript.turns()).unwrap(), before);
    }

    #[test]
    fn metadata_merges_like_the_ai_sdk() {
        let merged = merge(
            serde_json::json!({"a": {"b": 1, "c": 2}, "d": 1}),
            &serde_json::json!({"a": {"c": 3}, "e": 4}),
        );
        assert_eq!(
            merged,
            serde_json::json!({"a": {"b": 1, "c": 3}, "d": 1, "e": 4})
        );
    }
}
