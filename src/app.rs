//! Demo application: a counter that shows every part of the architecture,
//! including an asynchronous command.

use std::thread;
use std::time::Duration;

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    Frame,
    layout::{Constraint, Layout},
    style::{Color, Style, Stylize},
    text::Line,
    widgets::{Block, Paragraph},
};

use crate::tea::{Cmd, Model};

#[derive(Debug, Default)]
pub struct App {
    counter: i64,
    pending_tasks: usize,
    status: String,
}

#[derive(Debug)]
pub enum Msg {
    Increment,
    Decrement,
    Reset,
    /// Kick off a slow background job.
    StartSlowIncrement,
    /// The slow job finished with this delta.
    SlowIncrementDone(i64),
    Quit,
}

impl Model for App {
    type Msg = Msg;

    fn init() -> (Self, Cmd<Msg>) {
        let app = App {
            status: "ready".into(),
            ..Default::default()
        };
        (app, Cmd::none())
    }

    fn on_event(&self, event: Event) -> Option<Msg> {
        let Event::Key(key) = event else { return None };
        if key.kind != KeyEventKind::Press {
            return None;
        }
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => Some(Msg::Quit),
            KeyCode::Char('q') | KeyCode::Esc => Some(Msg::Quit),
            KeyCode::Char('k') | KeyCode::Up | KeyCode::Char('+') => Some(Msg::Increment),
            KeyCode::Char('j') | KeyCode::Down | KeyCode::Char('-') => Some(Msg::Decrement),
            KeyCode::Char('r') => Some(Msg::Reset),
            KeyCode::Char('s') => Some(Msg::StartSlowIncrement),
            _ => None,
        }
    }

    fn update(&mut self, msg: Msg) -> Cmd<Msg> {
        match msg {
            Msg::Increment => {
                self.counter += 1;
                Cmd::none()
            }
            Msg::Decrement => {
                self.counter -= 1;
                Cmd::none()
            }
            Msg::Reset => {
                self.counter = 0;
                self.status = "reset".into();
                Cmd::none()
            }
            Msg::StartSlowIncrement => {
                self.pending_tasks += 1;
                self.status = "working…".into();
                Cmd::task(|| {
                    thread::sleep(Duration::from_secs(1));
                    Msg::SlowIncrementDone(10)
                })
            }
            Msg::SlowIncrementDone(delta) => {
                self.pending_tasks -= 1;
                self.counter += delta;
                if self.pending_tasks == 0 {
                    self.status = "done".into();
                }
                Cmd::none()
            }
            Msg::Quit => Cmd::quit(),
        }
    }

    fn view(&self, frame: &mut Frame) {
        let [main, footer] =
            Layout::vertical([Constraint::Fill(1), Constraint::Length(1)]).areas(frame.area());

        let title = Line::from(" q ").bold();
        let body = vec![
            Line::from(""),
            Line::from(vec![
                "counter: ".into(),
                self.counter.to_string().bold().fg(Color::Yellow),
            ]),
            Line::from(vec![
                "status:  ".into(),
                self.status.clone().fg(Color::Cyan),
                if self.pending_tasks > 0 {
                    format!(" ({} pending)", self.pending_tasks).dim()
                } else {
                    "".into()
                },
            ]),
        ];
        frame.render_widget(
            Paragraph::new(body).block(Block::bordered().title(title)),
            main,
        );

        let help = Line::from(vec![
            " k/↑/+ ".bold(),
            "inc ".into(),
            " j/↓/- ".bold(),
            "dec ".into(),
            " r ".bold(),
            "reset ".into(),
            " s ".bold(),
            "slow +10 ".into(),
            " q ".bold(),
            "quit".into(),
        ])
        .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(Paragraph::new(help), footer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(code: KeyCode) -> Event {
        Event::Key(crossterm::event::KeyEvent::new(code, KeyModifiers::NONE))
    }

    #[test]
    fn starts_at_zero() {
        let (app, _) = App::init();
        assert_eq!(app.counter, 0);
    }

    #[test]
    fn keys_map_to_messages() {
        let (app, _) = App::init();
        assert!(matches!(
            app.on_event(press(KeyCode::Char('k'))),
            Some(Msg::Increment)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Char('j'))),
            Some(Msg::Decrement)
        ));
        assert!(matches!(
            app.on_event(press(KeyCode::Char('q'))),
            Some(Msg::Quit)
        ));
        assert!(app.on_event(press(KeyCode::Char('x'))).is_none());
    }

    #[test]
    fn increment_and_decrement() {
        let (mut app, _) = App::init();
        app.update(Msg::Increment);
        app.update(Msg::Increment);
        app.update(Msg::Decrement);
        assert_eq!(app.counter, 1);
    }

    #[test]
    fn slow_increment_round_trip() {
        let (mut app, _) = App::init();
        let cmd = app.update(Msg::StartSlowIncrement);
        assert_eq!(app.pending_tasks, 1);
        let Cmd::Task(job) = cmd else {
            panic!("expected a task")
        };
        let msg = job();
        assert!(matches!(msg, Msg::SlowIncrementDone(10)));
        app.update(msg);
        assert_eq!(app.counter, 10);
        assert_eq!(app.pending_tasks, 0);
        assert_eq!(app.status, "done");
    }

    #[test]
    fn quit_requests_exit() {
        let (mut app, _) = App::init();
        assert!(matches!(app.update(Msg::Quit), Cmd::Quit));
    }
}
