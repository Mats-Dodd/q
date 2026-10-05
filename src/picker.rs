//! The session picker: every session, most recently used first, to open one or
//! start a new one.

use chrono::{DateTime, Utc};
use ratatui::Frame;
use ratatui::layout::{Constraint, Flex, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, List, ListItem, ListState, Paragraph};

use crate::api::ApiError;
use crate::wire::Session;

#[derive(Debug)]
pub enum Sessions {
    Loading,
    Loaded(Vec<Session>),
    Failed(ApiError),
}

#[derive(Debug)]
pub struct Picker {
    pub sessions: Sessions,
    selected: usize,
}

impl Picker {
    #[must_use]
    pub fn loading() -> Self {
        Picker {
            sessions: Sessions::Loading,
            selected: 0,
        }
    }

    pub fn listed(&mut self, sessions: Result<Vec<Session>, ApiError>) {
        self.sessions = match sessions {
            Ok(sessions) => Sessions::Loaded(sessions),
            Err(error) => Sessions::Failed(error),
        };
        self.selected = 0;
    }

    /// Moves the selection by `by`, staying within the list.
    pub fn select(&mut self, by: isize) {
        if let Sessions::Loaded(sessions) = &self.sessions {
            let last = sessions.len().saturating_sub(1);
            self.selected = self.selected.saturating_add_signed(by).min(last);
        }
    }

    /// The selected session, if the list has loaded and is not empty.
    #[must_use]
    pub fn selected(&self) -> Option<&Session> {
        match &self.sessions {
            Sessions::Loaded(sessions) => sessions.get(self.selected),
            Sessions::Loading | Sessions::Failed(_) => None,
        }
    }

    pub fn view(&self, frame: &mut Frame, area: Rect) {
        let area = centered(area, 72, 20);
        frame.render_widget(Clear, area);
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .title(" sessions ")
            .title_bottom(Line::from(" ⏎ open · n new · esc close ").fg(Color::DarkGray));
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let message = match &self.sessions {
            Sessions::Loading => Some("loading…".to_owned()),
            Sessions::Failed(error) => Some(error.to_string()),
            Sessions::Loaded(sessions) if sessions.is_empty() => Some("no sessions yet".to_owned()),
            Sessions::Loaded(_) => None,
        };
        if let Some(message) = message {
            frame.render_widget(Paragraph::new(message).fg(Color::DarkGray), inner);
            return;
        }
        let Sessions::Loaded(sessions) = &self.sessions else {
            return;
        };
        let now = Utc::now();
        let items = sessions.iter().map(|session| {
            ListItem::new(Line::from(vec![
                Span::raw(session.title.to_string()),
                Span::styled(
                    format!("  {}", ago(session.updated_at, now)),
                    Style::new().fg(Color::DarkGray),
                ),
            ]))
        });
        let list = List::new(items).highlight_style(Style::new().add_modifier(Modifier::REVERSED));
        frame.render_stateful_widget(
            list,
            inner,
            &mut ListState::default().with_selected(Some(self.selected)),
        );
    }
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let [area] = Layout::horizontal([Constraint::Length(width)])
        .flex(Flex::Center)
        .areas(area);
    let [area] = Layout::vertical([Constraint::Length(height)])
        .flex(Flex::Center)
        .areas(area);
    area
}

/// How long ago `then` was, roughly.
fn ago(then: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let seconds = (now - then).num_seconds().max(0);
    match seconds {
        0..60 => "just now".to_owned(),
        60..3_600 => format!("{}m ago", seconds / 60),
        3_600..86_400 => format!("{}h ago", seconds / 3_600),
        _ => format!("{}d ago", seconds / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_how_long_ago_roughly() {
        let now = Utc::now();
        assert_eq!(ago(now, now), "just now");
        assert_eq!(ago(now - chrono::Duration::minutes(5), now), "5m ago");
        assert_eq!(ago(now - chrono::Duration::hours(3), now), "3h ago");
        assert_eq!(ago(now - chrono::Duration::days(2), now), "2d ago");
    }

    #[test]
    fn selection_stays_in_the_list() {
        let mut picker = Picker::loading();
        picker.select(1);
        assert!(picker.selected().is_none());
        picker.listed(Ok(Vec::new()));
        picker.select(-1);
        assert!(picker.selected().is_none());
    }
}
