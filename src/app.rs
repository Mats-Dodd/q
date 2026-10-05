//! The q TUI: a session's conversation, live, and a box to talk in.
//!
//! The model never talks to the server itself: listing, creating and opening
//! sessions, sending, cancelling and the live stream are all commands whose
//! results come back as messages. What a conversation looks like is entirely
//! its session's stream, folded into a [`Transcript`].
//!
//! A new conversation has no session until its first message, which creates
//! one (titled after the message).

use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, BorderType, Padding, Paragraph, Wrap};
use ratatui_textarea::TextArea;
use uuid::Uuid;

use crate::api::{ApiClient, ApiError, LiveUpdate};
use crate::picker::Picker;
use crate::tea::{Cmd, Model, Subscription};
use crate::transcript::Transcript;
use crate::view::{self, Connection, Status};
use crate::wire::{Offset, Session, SessionId, StartTurn, Turn, TurnId};

/// Session titles are the first line of the first message, up to this many characters.
const TITLE_LENGTH: usize = 60;

/// What the program starts with.
#[derive(Debug, Clone)]
pub enum Start {
    /// A new conversation (its session is created by the first message).
    New,
    /// The most recently used session, or a new conversation if there is none.
    Continue,
    /// The session picker.
    Pick,
    /// This session.
    Session(SessionId),
}

pub struct Flags {
    pub api: ApiClient,
    pub start: Start,
}

#[derive(Debug)]
pub enum Msg {
    /// Edit the message being written.
    EditInput(KeyEvent),
    PasteInput(String),
    SendInput,
    CancelTurn,
    Scroll(Scroll),
    Quit,
    OpenPicker,
    ClosePicker,
    /// Move the picker's selection by this many rows.
    PickerSelect(isize),
    OpenSelectedSession,
    StartNewConversation,
    SessionsListed {
        purpose: Listing,
        result: Result<Vec<Session>, ApiError>,
    },
    SessionFetched(Result<Session, ApiError>),
    /// The session a new conversation's first message created; `text` is that message.
    SessionCreated {
        text: String,
        result: Result<Session, ApiError>,
    },
    Live {
        session: SessionId,
        update: LiveUpdate,
    },
    TurnStartAnswered {
        text: String,
        result: Result<Turn, ApiError>,
    },
    CancelAnswered(Result<(), ApiError>),
}

/// Why sessions were listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listing {
    /// To open the most recent one.
    Continue,
    /// For the picker.
    Pick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scroll {
    PageUp,
    PageDown,
}

/// The session the conversation belongs to.
#[derive(Debug)]
enum Current {
    /// None yet: the first message creates one.
    New,
    /// The first message's session is being created.
    Creating,
    Open {
        id: SessionId,
        title: String,
    },
}

pub struct App {
    api: ApiClient,
    current: Current,
    /// The live read of the open session's stream; replacing it stops the old one.
    following: Option<Subscription>,
    transcript: Transcript,
    connection: Connection,
    input: TextArea<'static>,
    /// A message is on its way to the server.
    sending: bool,
    /// The last thing worth telling the user (an error, mostly).
    notice: Option<String>,
    picker: Option<Picker>,
    /// The first line shown, or `None` to follow the end of the conversation.
    scroll: Option<u16>,
    /// Render caches: each turn's lines (by revision), and the last viewport.
    rendered: Vec<(u64, Vec<Line<'static>>)>,
    viewport: Viewport,
}

/// The transcript's size at the last render, for paging.
#[derive(Default, Clone, Copy)]
struct Viewport {
    lines: u16,
    height: u16,
}

impl App {
    fn replying(&self) -> bool {
        self.sending
            || matches!(self.current, Current::Creating)
            || self.transcript.running().is_some()
    }

    fn open_session_id(&self) -> Option<&SessionId> {
        match &self.current {
            Current::Open { id, .. } => Some(id),
            Current::New | Current::Creating => None,
        }
    }

    /// The top line when following the end.
    fn bottom(&self) -> u16 {
        self.viewport.lines.saturating_sub(self.viewport.height)
    }

    fn scroll(&mut self, scroll: Scroll) {
        let page = self.viewport.height.saturating_sub(2).max(1);
        let top = self.scroll.unwrap_or_else(|| self.bottom());
        self.scroll = match scroll {
            Scroll::PageUp => Some(top.saturating_sub(page)),
            Scroll::PageDown => Some(top.saturating_add(page)).filter(|top| *top < self.bottom()),
        };
    }

    /// Clears the conversation, ready for `current`.
    fn reset(&mut self, current: Current) {
        self.current = current;
        self.following = None;
        self.transcript = Transcript::default();
        self.connection = Connection::Idle;
        self.sending = false;
        self.notice = None;
        self.scroll = None;
        self.rendered.clear();
    }

    /// Shows `session`, following its stream from the beginning.
    fn open(&mut self, session: Session) -> Cmd<Msg> {
        self.reset(Current::Open {
            id: session.id.clone(),
            title: session.title.to_string(),
        });
        self.connection = Connection::Connecting;
        let api = self.api.clone();
        let (subscription, cmd) = Cmd::subscribe(move |dispatch| {
            api.follow_stream(&session.id, Offset("-1".to_owned()), |update| {
                dispatch.send(Msg::Live {
                    session: session.id.clone(),
                    update,
                })
            });
        });
        self.following = Some(subscription);
        cmd
    }

    fn list_sessions(&self, purpose: Listing) -> Cmd<Msg> {
        let api = self.api.clone();
        Cmd::task(move || Msg::SessionsListed {
            purpose,
            result: api.list_sessions(),
        })
    }

    fn send_input(&mut self) -> Cmd<Msg> {
        let text = self.input.lines().join("\n").trim().to_owned();
        if text.is_empty() {
            return Cmd::none();
        }
        if self.replying() {
            self.notice = Some("a turn is running (esc cancels it)".to_owned());
            return Cmd::none();
        }
        self.input = new_input();
        self.notice = None;
        self.scroll = None;
        match &self.current {
            Current::Open { id, .. } => self.start_turn(id.clone(), text),
            Current::New => {
                self.current = Current::Creating;
                let api = self.api.clone();
                Cmd::task(move || {
                    let result = api.create_session(&title_of(&text));
                    Msg::SessionCreated { text, result }
                })
            }
            Current::Creating => Cmd::none(),
        }
    }

    fn start_turn(&mut self, session: SessionId, text: String) -> Cmd<Msg> {
        let Ok(message) = text.clone().try_into() else {
            return Cmd::none();
        };
        self.sending = true;
        let request = StartTurn {
            turn_id: TurnId(Uuid::now_v7()),
            text: message,
        };
        let api = self.api.clone();
        Cmd::task(move || Msg::TurnStartAnswered {
            text,
            result: api.start_turn(&session, &request),
        })
    }

    /// Puts a message that could not be sent back in the input, unless something new was started.
    fn give_back(&mut self, text: String, error: &ApiError) {
        self.notice = Some(error.to_string());
        if self.input.is_empty() {
            self.input.insert_str(text);
        }
    }

    fn sessions_listed(
        &mut self,
        purpose: Listing,
        result: Result<Vec<Session>, ApiError>,
    ) -> Cmd<Msg> {
        match (purpose, result) {
            (Listing::Pick, result) => {
                if let Some(picker) = &mut self.picker {
                    picker.listed(result);
                }
                Cmd::none()
            }
            (Listing::Continue, Ok(sessions)) => sessions
                .into_iter()
                .next()
                .map_or_else(Cmd::none, |latest| self.open(latest)),
            (Listing::Continue, Err(error)) => {
                self.notice = Some(error.to_string());
                Cmd::none()
            }
        }
    }

    /// A new conversation's session exists: follow it, and start its first turn.
    fn session_created(&mut self, text: String, result: Result<Session, ApiError>) -> Cmd<Msg> {
        match result {
            Ok(session) => {
                let id = session.id.clone();
                let follow = self.open(session);
                Cmd::batch([follow, self.start_turn(id, text)])
            }
            Err(error) => {
                self.current = Current::New;
                self.give_back(text, &error);
                Cmd::none()
            }
        }
    }

    fn live(&mut self, session: &SessionId, update: LiveUpdate) {
        // Updates from a stream no longer followed are dropped.
        if self
            .open_session_id()
            .is_none_or(|open| open.0 != session.0)
        {
            return;
        }
        match update {
            LiveUpdate::Connected => self.connection = Connection::Live,
            LiveUpdate::Chunks { chunks, .. } => {
                for chunk in &chunks {
                    self.transcript.apply(chunk);
                }
            }
            LiveUpdate::Disconnected(error) => {
                self.connection = Connection::Down(error.to_string());
            }
        }
    }

    fn cancel_turn(&self) -> Cmd<Msg> {
        match (self.open_session_id(), self.transcript.running()) {
            (Some(session), Some(_)) => {
                let (api, session) = (self.api.clone(), session.clone());
                Cmd::task(move || Msg::CancelAnswered(api.cancel_turn(&session)))
            }
            _ => Cmd::none(),
        }
    }

    /// Lines for every turn, re-rendering only those that changed.
    fn transcript_lines(&mut self) -> Vec<Line<'static>> {
        let turns = self.transcript.turns();
        self.rendered.truncate(turns.len());
        for (i, turn) in turns.iter().enumerate() {
            match self.rendered.get_mut(i) {
                Some((revision, _)) if *revision == turn.revision => {}
                Some(entry) => *entry = (turn.revision, view::turn_lines(turn)),
                None => self.rendered.push((turn.revision, view::turn_lines(turn))),
            }
        }
        self.rendered
            .iter()
            .flat_map(|(_, lines)| lines.iter().cloned())
            .collect()
    }
}

fn new_input() -> TextArea<'static> {
    let mut input = TextArea::default();
    input.set_block(
        Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(Color::DarkGray)),
    );
    input.set_placeholder_text("Say something…");
    input.set_cursor_line_style(Style::new());
    input
}

/// A session's title: the first line of its first message, shortened.
fn title_of(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("q");
    if line.chars().count() <= TITLE_LENGTH {
        return line.to_owned();
    }
    let short: String = line.chars().take(TITLE_LENGTH).collect();
    format!("{}…", short.trim_end())
}

fn is_ctrl(key: &KeyEvent, c: char) -> bool {
    key.code == KeyCode::Char(c) && key.modifiers.contains(KeyModifiers::CONTROL)
}

impl Model for App {
    type Msg = Msg;
    type Flags = Flags;

    fn init(flags: Flags) -> (Self, Cmd<Msg>) {
        let mut app = App {
            api: flags.api,
            current: Current::New,
            following: None,
            transcript: Transcript::default(),
            connection: Connection::Idle,
            input: new_input(),
            sending: false,
            notice: None,
            picker: None,
            scroll: None,
            rendered: Vec::new(),
            viewport: Viewport::default(),
        };
        let cmd = match flags.start {
            Start::New => Cmd::none(),
            Start::Continue => app.list_sessions(Listing::Continue),
            Start::Pick => {
                app.picker = Some(Picker::loading());
                app.list_sessions(Listing::Pick)
            }
            Start::Session(id) => {
                let api = app.api.clone();
                Cmd::task(move || Msg::SessionFetched(api.get_session(&id)))
            }
        };
        (app, cmd)
    }

    fn on_event(&self, event: Event) -> Option<Msg> {
        let key = match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => key,
            Event::Paste(text) if self.picker.is_none() => return Some(Msg::PasteInput(text)),
            _ => return None,
        };
        if is_ctrl(&key, 'c') || is_ctrl(&key, 'd') {
            return Some(Msg::Quit);
        }
        if self.picker.is_some() {
            return match key.code {
                KeyCode::Up | KeyCode::Char('k') => Some(Msg::PickerSelect(-1)),
                KeyCode::Down | KeyCode::Char('j') => Some(Msg::PickerSelect(1)),
                KeyCode::Enter => Some(Msg::OpenSelectedSession),
                KeyCode::Char('n') => Some(Msg::StartNewConversation),
                KeyCode::Esc => Some(Msg::ClosePicker),
                _ => None,
            };
        }
        Some(match key.code {
            _ if is_ctrl(&key, 'o') => Msg::OpenPicker,
            KeyCode::Esc => Msg::CancelTurn,
            KeyCode::Enter if key.modifiers.is_empty() => Msg::SendInput,
            KeyCode::PageUp => Msg::Scroll(Scroll::PageUp),
            KeyCode::PageDown => Msg::Scroll(Scroll::PageDown),
            _ => Msg::EditInput(key),
        })
    }

    fn update(&mut self, msg: Msg) -> Cmd<Msg> {
        match msg {
            Msg::EditInput(key) => {
                self.input.input(key);
                Cmd::none()
            }
            Msg::PasteInput(text) => {
                self.input.insert_str(text);
                Cmd::none()
            }
            Msg::SendInput => self.send_input(),
            Msg::CancelTurn => self.cancel_turn(),
            Msg::Scroll(scroll) => {
                self.scroll(scroll);
                Cmd::none()
            }
            Msg::Quit => Cmd::quit(),
            Msg::OpenPicker => {
                self.picker = Some(Picker::loading());
                self.list_sessions(Listing::Pick)
            }
            Msg::ClosePicker => {
                self.picker = None;
                Cmd::none()
            }
            Msg::PickerSelect(by) => {
                if let Some(picker) = &mut self.picker {
                    picker.select(by);
                }
                Cmd::none()
            }
            Msg::OpenSelectedSession => {
                match self.picker.as_ref().and_then(Picker::selected).cloned() {
                    Some(session) => {
                        self.picker = None;
                        self.open(session)
                    }
                    None => Cmd::none(),
                }
            }
            Msg::StartNewConversation => {
                self.picker = None;
                self.reset(Current::New);
                Cmd::none()
            }
            Msg::SessionsListed { purpose, result } => self.sessions_listed(purpose, result),
            Msg::SessionFetched(result) => match result {
                Ok(session) => self.open(session),
                Err(error) => {
                    self.notice = Some(error.to_string());
                    Cmd::none()
                }
            },
            Msg::SessionCreated { text, result } => self.session_created(text, result),
            Msg::Live { session, update } => {
                self.live(&session, update);
                Cmd::none()
            }
            Msg::TurnStartAnswered { text, result } => {
                self.sending = false;
                if let Err(error) = result {
                    self.give_back(text, &error);
                }
                Cmd::none()
            }
            Msg::CancelAnswered(result) => {
                if let Err(error) = result {
                    self.notice = Some(error.to_string());
                }
                Cmd::none()
            }
        }
    }

    fn view(&mut self, frame: &mut Frame) {
        let input_height = u16::try_from(self.input.lines().len())
            .unwrap_or(u16::MAX)
            .clamp(1, 8)
            + 2;
        let [main, input, footer] = Layout::vertical([
            Constraint::Fill(1),
            Constraint::Length(input_height),
            Constraint::Length(1),
        ])
        .areas(frame.area());

        let transcript = Paragraph::new(self.transcript_lines())
            .wrap(Wrap { trim: false })
            .block(Block::new().padding(Padding::horizontal(1)));
        self.viewport = Viewport {
            lines: u16::try_from(transcript.line_count(main.width)).unwrap_or(u16::MAX),
            height: main.height,
        };
        let top = self
            .scroll
            .unwrap_or_else(|| self.bottom())
            .min(self.bottom());
        frame.render_widget(transcript.scroll((top, 0)), main);
        frame.render_widget(&self.input, input);

        let model = self
            .transcript
            .turns()
            .iter()
            .rev()
            .find_map(|turn| turn.model.as_deref());
        let title = match &self.current {
            Current::Open { title, .. } => title.as_str(),
            Current::New | Current::Creating => "new conversation",
        };
        let status = Status {
            title,
            model,
            connection: &self.connection,
            replying: self.replying(),
            notice: self.notice.as_deref(),
        };
        frame.render_widget(Paragraph::new(view::status_line(&status)), footer);

        if let Some(picker) = &self.picker {
            picker.view(frame, frame.area());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::IncomingChunk;

    fn app() -> App {
        App::init(Flags {
            api: ApiClient::new("http://127.0.0.1:1"),
            start: Start::New,
        })
        .0
    }

    fn press(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent::new(code, modifiers))
    }

    fn session(title: &str) -> Session {
        serde_json::from_value(serde_json::json!({
            "id": Uuid::now_v7(),
            "title": title,
            "createdAt": "2026-10-01T00:00:00Z",
            "updatedAt": "2026-10-01T00:00:00Z"
        }))
        .unwrap()
    }

    fn chunk(json: &str) -> IncomingChunk {
        serde_json::from_str(json).unwrap()
    }

    fn type_text(app: &mut App, text: &str) {
        app.update(Msg::PasteInput(text.to_owned()));
    }

    /// An app with `session` open.
    fn opened(session: &Session) -> App {
        let mut app = app();
        app.update(Msg::SessionFetched(Ok(session.clone())));
        app
    }

    fn live(app: &mut App, session: &Session, chunks: Vec<IncomingChunk>) {
        let update = LiveUpdate::Chunks {
            chunks,
            next: Offset("0000000000000001".to_owned()),
        };
        app.update(Msg::Live {
            session: session.id.clone(),
            update,
        });
    }

    #[test]
    fn keys_map_to_messages() {
        let app = app();
        assert!(matches!(
            app.on_event(press(KeyCode::Enter, KeyModifiers::NONE)),
            Some(Msg::SendInput)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Enter, KeyModifiers::SHIFT)),
            Some(Msg::EditInput(_))
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Esc, KeyModifiers::NONE)),
            Some(Msg::CancelTurn)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Char('o'), KeyModifiers::CONTROL)),
            Some(Msg::OpenPicker)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(Msg::Quit)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Char('c'), KeyModifiers::NONE)),
            Some(Msg::EditInput(_))
        ));
        assert!(matches!(
            app.on_event(Event::Paste("x".into())),
            Some(Msg::PasteInput(_))
        ));
    }

    #[test]
    fn the_picker_takes_the_keys_while_open() {
        let mut app = app();
        app.update(Msg::OpenPicker);
        assert!(matches!(
            app.on_event(press(KeyCode::Char('j'), KeyModifiers::NONE)),
            Some(Msg::PickerSelect(1))
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Enter, KeyModifiers::NONE)),
            Some(Msg::OpenSelectedSession)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Char('n'), KeyModifiers::NONE)),
            Some(Msg::StartNewConversation)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Esc, KeyModifiers::NONE)),
            Some(Msg::ClosePicker)
        ));
        assert!(app.on_event(Event::Paste("x".into())).is_none());
    }

    #[test]
    fn a_new_conversation_has_no_session_until_its_first_message() {
        let mut app = app();
        assert!(matches!(app.current, Current::New));
        type_text(&mut app, "  write me a haiku  ");
        assert!(matches!(app.update(Msg::SendInput), Cmd::Task(_)));
        assert!(matches!(app.current, Current::Creating));
        assert!(app.input.is_empty() && app.replying());

        let created = session("write me a haiku");
        let text = "write me a haiku".to_owned();
        let cmd = app.update(Msg::SessionCreated {
            text,
            result: Ok(created.clone()),
        });
        assert!(
            matches!(cmd, Cmd::Batch(ref cmds) if cmds.len() == 2),
            "follows the stream and starts the turn"
        );
        assert!(app.open_session_id().is_some_and(|id| id.0 == created.id.0));
        assert!(app.following.is_some());
    }

    #[test]
    fn a_session_that_cannot_be_created_gives_the_message_back() {
        let mut app = app();
        type_text(&mut app, "hello");
        app.update(Msg::SendInput);
        let error = ApiError::Transport("refused".to_owned());
        app.update(Msg::SessionCreated {
            text: "hello".to_owned(),
            result: Err(error),
        });
        assert!(matches!(app.current, Current::New));
        assert_eq!(app.input.lines(), ["hello"]);
        assert!(!app.replying());
    }

    #[test]
    fn titles_are_the_first_line_shortened() {
        assert_eq!(title_of("\n  hello there \nmore"), "hello there");
        assert_eq!(title_of(&"word ".repeat(30)).chars().count(), TITLE_LENGTH);
        assert!(title_of(&"word ".repeat(30)).ends_with("word…"));
    }

    #[test]
    fn one_turn_at_a_time() {
        let mut app = opened(&session("s"));
        type_text(&mut app, "first");
        assert!(matches!(app.update(Msg::SendInput), Cmd::Task(_)));
        type_text(&mut app, "second");
        assert!(matches!(app.update(Msg::SendInput), Cmd::None));
        assert_eq!(app.input.lines(), ["second"]);
    }

    #[test]
    fn a_failed_send_gives_the_message_back() {
        let mut app = opened(&session("s"));
        let failure = Err(ApiError::Api {
            status: 409,
            tag: Some("TurnInProgress".to_owned()),
        });
        app.update(Msg::TurnStartAnswered {
            text: "hello".to_owned(),
            result: failure,
        });
        assert_eq!(app.input.lines(), ["hello"]);
        assert_eq!(app.notice.as_deref(), Some("a turn is already running"));
        assert!(!app.replying());
    }

    #[test]
    fn the_stream_drives_the_conversation() {
        let open = session("s");
        let mut app = opened(&open);
        let id = "01a10400-0000-7000-8000-000000000001";
        app.update(Msg::Live {
            session: open.id.clone(),
            update: LiveUpdate::Connected,
        });
        live(
            &mut app,
            &open,
            vec![
                chunk(&format!(
                    r#"{{"type":"data-user-message","id":"{id}","data":{{"text":"hi"}}}}"#
                )),
                chunk(&format!(
                    r#"{{"type":"data-turn-start","id":"{id}","data":{{"model":"m"}}}}"#
                )),
            ],
        );
        assert_eq!(app.connection, Connection::Live);
        assert!(app.replying());
        assert!(matches!(app.cancel_turn(), Cmd::Task(_)));

        live(
            &mut app,
            &open,
            vec![chunk(&format!(
                r#"{{"type":"data-turn-end","id":"{id}","data":{{"reason":"completed"}}}}"#
            ))],
        );
        assert!(!app.replying());
    }

    #[test]
    fn updates_from_a_session_no_longer_open_are_dropped() {
        let (old, new) = (session("old"), session("new"));
        let mut app = opened(&old);
        app.update(Msg::SessionFetched(Ok(new.clone())));
        let id = "01a10400-0000-7000-8000-000000000001";
        live(
            &mut app,
            &old,
            vec![chunk(&format!(
                r#"{{"type":"data-user-message","id":"{id}","data":{{"text":"hi"}}}}"#
            ))],
        );
        assert!(app.transcript.turns().is_empty());
    }

    #[test]
    fn picking_a_session_opens_it() {
        let mut app = app();
        app.update(Msg::OpenPicker);
        let (a, b) = (session("a"), session("b"));
        app.update(Msg::SessionsListed {
            purpose: Listing::Pick,
            result: Ok(vec![a, b.clone()]),
        });
        app.update(Msg::PickerSelect(1));
        assert!(matches!(
            app.update(Msg::OpenSelectedSession),
            Cmd::Subscribe(..)
        ));
        assert!(app.picker.is_none());
        assert!(app.open_session_id().is_some_and(|id| id.0 == b.id.0));
    }

    #[test]
    fn continuing_opens_the_latest_session_or_starts_fresh() {
        let mut continued = app();
        let latest = session("latest");
        let listed = Ok(vec![latest.clone(), session("older")]);
        continued.update(Msg::SessionsListed {
            purpose: Listing::Continue,
            result: listed,
        });
        assert!(
            continued
                .open_session_id()
                .is_some_and(|id| id.0 == latest.id.0)
        );

        let mut fresh = app();
        fresh.update(Msg::SessionsListed {
            purpose: Listing::Continue,
            result: Ok(Vec::new()),
        });
        assert!(matches!(fresh.current, Current::New));
    }

    #[test]
    fn starting_a_new_conversation_leaves_the_old_session() {
        let mut app = opened(&session("s"));
        app.update(Msg::OpenPicker);
        app.update(Msg::StartNewConversation);
        assert!(matches!(app.current, Current::New));
        assert!(app.following.is_none() && app.picker.is_none());
    }

    /// The screen after the `simple` fixture's stream, rendered for real.
    #[test]
    fn renders_a_conversation() {
        let open = session("greetings");
        let mut app = opened(&open);
        app.update(Msg::Live {
            session: open.id.clone(),
            update: LiveUpdate::Connected,
        });
        let stream = std::fs::read_to_string("server/test/fixtures/sessions/simple.jsonl").unwrap();
        live(&mut app, &open, stream.lines().map(chunk).collect());

        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(60, 12)).unwrap();
        terminal.draw(|frame| app.view(frame)).unwrap();
        let screen: Vec<String> = terminal
            .backend()
            .buffer()
            .content
            .chunks(60)
            .map(|row| {
                row.iter()
                    .map(ratatui::buffer::Cell::symbol)
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect();

        assert!(screen.iter().any(|row| row.contains("› hello")));
        assert!(
            screen.iter().any(|row| row.contains("Hi there, friend.")),
            "markdown is rendered"
        );
        assert!(screen.iter().any(|row| row.contains("Say something")));
        let status = screen.last().unwrap();
        assert!(
            status.contains("greetings")
                && status.contains("claude-haiku-4-5")
                && status.contains("● live"),
            "{status}"
        );
    }

    #[test]
    fn paging_up_stops_following_and_paging_back_down_resumes() {
        let mut app = app();
        app.viewport = Viewport {
            lines: 100,
            height: 20,
        };
        app.update(Msg::Scroll(Scroll::PageUp));
        assert_eq!(app.scroll, Some(62));
        app.update(Msg::Scroll(Scroll::PageDown));
        assert_eq!(app.scroll, None);
    }
}
