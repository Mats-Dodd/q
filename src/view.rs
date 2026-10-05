//! Rendering: turns into styled lines (Markdown for replies), and the status line.

use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span, Text};

use crate::transcript::{Part, TranscriptTurn};
use crate::wire::TurnEndReason;

const USER: Style = Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD);
const REASONING: Style = Style::new()
    .fg(Color::DarkGray)
    .add_modifier(Modifier::ITALIC);
const ERROR: Style = Style::new().fg(Color::Red);
const QUIET: Style = Style::new().fg(Color::DarkGray);

/// A turn as lines: the user's message, the reply, and how it ended.
#[must_use]
pub fn turn_lines(turn: &TranscriptTurn) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for (i, line) in turn.text.lines().enumerate() {
        let prefix = if i == 0 { "› " } else { "  " };
        lines.push(Line::from(vec![
            Span::styled(prefix, USER),
            Span::styled(line.to_owned(), USER),
        ]));
    }
    lines.push(Line::default());

    let parts = turn.reply().map_or(&[][..], |reply| reply.parts);
    let said_anything = parts.iter().any(|part| !matches!(part, Part::StepStart));
    for part in parts {
        match part {
            Part::StepStart => {}
            Part::Text { text, .. } => lines.extend(markdown(text)),
            Part::Reasoning { text, .. } => {
                lines.extend(
                    text.lines()
                        .map(|line| Line::styled(line.to_owned(), REASONING)),
                );
            }
            Part::File { url, .. } | Part::ReasoningFile { url, .. } => {
                lines.push(Line::styled(format!("[file] {url}"), QUIET));
            }
            Part::SourceUrl { url, title, .. } => {
                lines.push(Line::styled(
                    format!("[source] {}", title.as_deref().unwrap_or(url)),
                    QUIET,
                ));
            }
            Part::SourceDocument { title, .. } => {
                lines.push(Line::styled(format!("[source] {title}"), QUIET));
            }
            Part::Custom { kind, .. } => lines.push(Line::styled(format!("[{kind}]"), QUIET)),
        }
    }
    if turn.end.is_none() && !said_anything {
        lines.push(Line::styled("…", QUIET));
    }
    for error in &turn.errors {
        lines.push(Line::styled(format!("✗ {error}"), ERROR));
    }
    if turn.end == Some(TurnEndReason::Cancelled) {
        lines.push(Line::styled("⏹ cancelled", QUIET));
    }
    lines.push(Line::default());
    lines
}

/// Markdown, rendered and owned (the renderer borrows its input).
fn markdown(text: &str) -> Vec<Line<'static>> {
    let Text { lines, .. } = tui_markdown::from_str(text);
    lines
        .into_iter()
        .map(|line| Line {
            spans: line
                .spans
                .into_iter()
                .map(|span| Span::styled(span.content.into_owned(), span.style))
                .collect(),
            ..line
        })
        .collect()
}

/// Where the connection to the server stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Connection {
    /// No session is open, so there is nothing to follow.
    Idle,
    Connecting,
    Live,
    Down(String),
}

/// What the status line shows.
pub struct Status<'a> {
    pub title: &'a str,
    pub model: Option<&'a str>,
    pub connection: &'a Connection,
    pub replying: bool,
    pub notice: Option<&'a str>,
}

#[must_use]
pub fn status_line(status: &Status<'_>) -> Line<'static> {
    let mut spans = vec![
        " q ".bold().reversed(),
        " ".into(),
        Span::raw(status.title.to_owned()),
        " ".into(),
    ];
    if let Some(model) = status.model {
        spans.push(Span::styled(model.to_owned(), QUIET));
        spans.push(" ".into());
    }
    spans.push(match status.connection {
        Connection::Idle => Span::styled("○", QUIET),
        Connection::Connecting => "◌ connecting".yellow(),
        Connection::Live => "● live".green(),
        Connection::Down(reason) => Span::styled(format!("✗ {reason}"), ERROR),
    });
    if status.replying {
        spans.push("  ◆ replying".magenta());
    }
    if let Some(notice) = status.notice {
        spans.push(Span::styled(
            format!("  {notice}"),
            Style::new().fg(Color::Yellow),
        ));
    }
    spans.push(Span::styled(
        "   ⏎ send · ⇧⏎ newline · esc cancel · ^o sessions · ^c quit",
        QUIET,
    ));
    Line::from(spans)
}
