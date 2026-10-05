//! A ApiClient-Sent Events reader: just enough of the event-stream format
//! (<https://html.spec.whatwg.org/multipage/server-sent-events.html>) for
//! session streams.

use std::io::{self, BufRead};

/// One dispatched event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// The `event:` field; `message` when absent.
    pub event: String,
    /// Every `data:` line of the event, joined by newlines.
    pub data: String,
}

/// The events read from `reader`, until it ends.
pub fn events<R: BufRead>(reader: R) -> impl Iterator<Item = io::Result<Event>> {
    let mut lines = reader.lines();
    let mut event = String::new();
    let mut data: Option<String> = None;
    std::iter::from_fn(move || {
        loop {
            let line = match lines.next()? {
                Ok(line) => line,
                Err(error) => return Some(Err(error)),
            };
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                // A blank line dispatches the event, if it has data.
                let name = std::mem::take(&mut event);
                if let Some(data) = data.take() {
                    let event = if name.is_empty() {
                        "message".to_owned()
                    } else {
                        name
                    };
                    return Some(Ok(Event { event, data }));
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => value.clone_into(&mut event),
                "data" => match &mut data {
                    Some(data) => {
                        data.push('\n');
                        data.push_str(value);
                    }
                    None => data = Some(value.to_owned()),
                },
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Vec<Event> {
        events(text.as_bytes()).collect::<io::Result<_>>().unwrap()
    }

    fn event(event: &str, data: &str) -> Event {
        Event {
            event: event.to_owned(),
            data: data.to_owned(),
        }
    }

    #[test]
    fn reads_named_events() {
        let text = "event: data\ndata: [1]\n\nevent: control\ndata: {\"a\":1}\n\n";
        assert_eq!(
            read(text),
            [event("data", "[1]"), event("control", "{\"a\":1}")]
        );
    }

    #[test]
    fn joins_multi_line_data_and_handles_crlf() {
        let text = "event: data\r\ndata: [\r\ndata: 1\r\ndata: ]\r\n\r\n";
        assert_eq!(read(text), [event("data", "[\n1\n]")]);
    }

    #[test]
    fn defaults_the_event_name_and_skips_comments_and_empty_events() {
        let text = ": keep-alive\n\nevent: nothing\n\ndata:x\n\n";
        assert_eq!(read(text), [event("message", "x")]);
    }

    #[test]
    fn an_unterminated_event_is_not_dispatched() {
        assert_eq!(read("event: data\ndata: [1]\n"), []);
    }
}
