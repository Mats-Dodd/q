//! A minimal Elm-architecture runtime for ratatui.
//!
//! The application is a [`Model`] with three responsibilities:
//!
//! * `update`  – pure state transition: `(model, msg) -> cmd`
//! * `view`    – render the current model into a ratatui [`Frame`]
//! * `on_event` – translate terminal input into a domain message
//!
//! Side effects never happen inside `update`. Instead it returns a [`Cmd`],
//! which the runtime executes. Long-running work goes through [`Cmd::Task`]
//! and delivers its result back into the loop as an ordinary message.

use std::io;
use std::sync::mpsc::{self, Sender};
use std::thread;

use crossterm::event::{self, Event};
use ratatui::{DefaultTerminal, Frame};

/// An effect requested by `update`, executed by the runtime.
pub enum Cmd<Msg> {
    /// Do nothing.
    None,
    /// Run work on a background thread; the returned message is delivered
    /// to `update` when it finishes.
    Task(Box<dyn FnOnce() -> Msg + Send + 'static>),
    /// Stop the program.
    Quit,
}

impl<Msg> Cmd<Msg> {
    pub fn none() -> Self {
        Cmd::None
    }

    pub fn task(f: impl FnOnce() -> Msg + Send + 'static) -> Self {
        Cmd::Task(Box::new(f))
    }

    pub fn quit() -> Self {
        Cmd::Quit
    }
}

/// The application contract.
pub trait Model: Sized {
    type Msg: Send + 'static;

    /// Initial state and any startup effects.
    fn init() -> (Self, Cmd<Self::Msg>);

    /// Map a raw terminal event to a message. Return `None` to ignore it.
    fn on_event(&self, event: Event) -> Option<Self::Msg>;

    /// Apply a message to the model, returning follow-up effects.
    fn update(&mut self, msg: Self::Msg) -> Cmd<Self::Msg>;

    /// Draw the model.
    fn view(&self, frame: &mut Frame);
}

/// Everything that can wake the main loop.
enum Incoming<Msg> {
    Event(Event),
    Msg(Msg),
}

/// Run `M` until it returns [`Cmd::Quit`].
///
/// Input is read on a dedicated thread and funnelled, together with task
/// results, into one channel. The loop blocks on that channel, so it only
/// wakes and redraws when something actually happened.
pub fn run<M: Model>(terminal: &mut DefaultTerminal) -> io::Result<()> {
    let (tx, rx) = mpsc::channel::<Incoming<M::Msg>>();
    spawn_input_thread(tx.clone());

    let (mut model, cmd) = M::init();
    if exec(cmd, &tx) == Flow::Quit {
        return Ok(());
    }

    loop {
        terminal.draw(|frame| model.view(frame))?;

        // Block for the first wake-up, then drain whatever else is pending
        // so a burst of input produces a single redraw.
        let first = rx
            .recv()
            .map_err(|_| io::Error::other("input channel closed"))?;
        let pending = std::iter::once(first).chain(std::iter::from_fn(|| rx.try_recv().ok()));

        for incoming in pending {
            let msg = match incoming {
                Incoming::Event(event) => match model.on_event(event) {
                    Some(msg) => msg,
                    None => continue,
                },
                Incoming::Msg(msg) => msg,
            };
            if exec(model.update(msg), &tx) == Flow::Quit {
                return Ok(());
            }
        }
    }
}

#[derive(PartialEq, Eq)]
enum Flow {
    Continue,
    Quit,
}

fn exec<Msg: Send + 'static>(cmd: Cmd<Msg>, tx: &Sender<Incoming<Msg>>) -> Flow {
    match cmd {
        Cmd::None => Flow::Continue,
        Cmd::Task(f) => {
            let tx = tx.clone();
            thread::spawn(move || {
                // If the loop is gone the result is simply dropped.
                let _ = tx.send(Incoming::Msg(f()));
            });
            Flow::Continue
        }
        Cmd::Quit => Flow::Quit,
    }
}

fn spawn_input_thread<Msg: Send + 'static>(tx: Sender<Incoming<Msg>>) {
    thread::spawn(move || {
        while let Ok(event) = event::read() {
            if tx.send(Incoming::Event(event)).is_err() {
                break;
            }
        }
    });
}
