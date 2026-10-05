//! A minimal Elm-architecture runtime for ratatui.
//!
//! The application is a [`Model`] with four responsibilities:
//!
//! * `init`     – initial state from its flags, and startup effects
//! * `update`   – pure state transition: `(model, msg) -> cmd`
//! * `view`     – render the current model into a ratatui [`Frame`]
//! * `on_event` – translate terminal input into a domain message
//!
//! Side effects never happen inside `update`. Instead it returns a [`Cmd`],
//! which the runtime executes. Background work goes through [`Cmd::Task`]
//! (one result) or [`Cmd::Subscribe`] (any number of results, e.g. a network
//! subscription), delivered back into the loop as ordinary messages.

use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Run work on a background thread that delivers messages through a
    /// [`Dispatch`] until it returns or its [`Subscription`] is dropped.
    Subscribe(
        Box<dyn FnOnce(Dispatch<Msg>) + Send + 'static>,
        Arc<AtomicBool>,
    ),
    /// Several effects at once.
    Batch(Vec<Cmd<Msg>>),
    /// Stop the program.
    Quit,
}

impl<Msg> Cmd<Msg> {
    #[must_use]
    pub fn none() -> Self {
        Cmd::None
    }

    pub fn task(f: impl FnOnce() -> Msg + Send + 'static) -> Self {
        Cmd::Task(Box::new(f))
    }

    /// Starts a subscription; it lasts as long as the returned handle does.
    pub fn subscribe(f: impl FnOnce(Dispatch<Msg>) + Send + 'static) -> (Subscription, Self) {
        let active = Arc::new(AtomicBool::new(true));
        (
            Subscription(Arc::clone(&active)),
            Cmd::Subscribe(Box::new(f), active),
        )
    }

    pub fn batch(cmds: impl IntoIterator<Item = Cmd<Msg>>) -> Self {
        Cmd::Batch(cmds.into_iter().collect())
    }

    #[must_use]
    pub fn quit() -> Self {
        Cmd::Quit
    }
}

/// A running [`Cmd::Subscribe`]: the model keeps it for as long as it wants
/// the messages. Dropping it stops them.
#[derive(Debug)]
pub struct Subscription(Arc<AtomicBool>);

impl Drop for Subscription {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Delivers messages from a [`Cmd::Subscribe`] into the loop.
pub struct Dispatch<Msg> {
    tx: Sender<Incoming<Msg>>,
    active: Arc<AtomicBool>,
}

impl<Msg> Dispatch<Msg> {
    /// Sends `msg` to `update`. Returns `false` once the subscription was
    /// dropped or the program has exited, so the work should stop.
    pub fn send(&self, msg: Msg) -> bool {
        self.active.load(Ordering::Relaxed) && self.tx.send(Incoming::Msg(msg)).is_ok()
    }
}

/// The application contract.
pub trait Model: Sized {
    type Msg: Send + 'static;
    /// What the program starts from, e.g. command-line options.
    type Flags;

    /// Initial state and any startup effects.
    fn init(flags: Self::Flags) -> (Self, Cmd<Self::Msg>);

    /// Map a raw terminal event to a message. Return `None` to ignore it.
    fn on_event(&self, event: Event) -> Option<Self::Msg>;

    /// Apply a message to the model, returning follow-up effects.
    fn update(&mut self, msg: Self::Msg) -> Cmd<Self::Msg>;

    /// Draw the model. It may update render caches (never state `update`
    /// depends on), hence `&mut self`.
    fn view(&mut self, frame: &mut Frame);
}

/// Everything that can wake the main loop.
enum Incoming<Msg> {
    Event(Event),
    Msg(Msg),
}

/// Run `M` until it returns [`Cmd::Quit`].
///
/// # Errors
/// Drawing to the terminal failed.
///
/// Input is read on a dedicated thread and funnelled, together with task
/// results, into one channel. The loop blocks on that channel, so it only
/// wakes and redraws when something actually happened.
pub fn run<M: Model>(terminal: &mut DefaultTerminal, flags: M::Flags) -> io::Result<()> {
    let (tx, rx) = mpsc::channel::<Incoming<M::Msg>>();
    spawn_input_thread(tx.clone());

    let (mut model, cmd) = M::init(flags);
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
        Cmd::Subscribe(f, active) => {
            let dispatch = Dispatch {
                tx: tx.clone(),
                active,
            };
            thread::spawn(move || f(dispatch));
            Flow::Continue
        }
        Cmd::Batch(cmds) => {
            for cmd in cmds {
                if exec(cmd, tx) == Flow::Quit {
                    return Flow::Quit;
                }
            }
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
