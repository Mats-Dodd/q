use std::io::{self, stdout};
use std::process::ExitCode;

use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, KeyboardEnhancementFlags,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::supports_keyboard_enhancement;

use q::api::ApiClient;
use q::app::{App, Flags, Start};
use q::tea;
use q::wire::SessionId;

const USAGE: &str = "usage: q [-c | -r | --session <id>] [--server <url>]

  (none)           a new conversation
  -c, --continue   the most recently used session
  -r, --resume     pick a session to resume
  --session <id>   this session
  --server <url>   the q server (default: $Q_SERVER_URL, or http://127.0.0.1:7777)";

fn main() -> ExitCode {
    let flags = match flags(std::env::args().skip(1)) {
        Ok(flags) => flags,
        Err(problem) => {
            eprintln!("{problem}\n\n{USAGE}");
            return ExitCode::FAILURE;
        }
    };
    match run(flags) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("q: {error}");
            ExitCode::FAILURE
        }
    }
}

fn flags(mut args: impl Iterator<Item = String>) -> Result<Flags, String> {
    let mut server_url =
        std::env::var("Q_SERVER_URL").unwrap_or_else(|_| "http://127.0.0.1:7777".to_owned());
    let mut start = Start::New;
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--server" => server_url = value("--server")?,
            "-c" | "--continue" => start = Start::Continue,
            "-r" | "--resume" => start = Start::Pick,
            "--session" => {
                let id = value("--session")?;
                start = Start::Session(SessionId(
                    id.parse().map_err(|_| format!("not a session id: {id}"))?,
                ));
            }
            "-h" | "--help" => return Err("q: a terminal client for the q agent".to_owned()),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Flags {
        api: ApiClient::new(server_url),
        start,
    })
}

fn run(flags: Flags) -> io::Result<()> {
    let mut terminal = ratatui::init();
    // Tell Shift+Enter from Enter where the terminal can.
    let enhanced = supports_keyboard_enhancement().unwrap_or(false);
    if enhanced {
        execute!(
            stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
    }
    execute!(stdout(), EnableBracketedPaste)?;

    let result = tea::run::<App>(&mut terminal, flags);

    execute!(stdout(), DisableBracketedPaste)?;
    if enhanced {
        execute!(stdout(), PopKeyboardEnhancementFlags)?;
    }
    ratatui::restore();
    result
}
