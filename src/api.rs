//! The q server's API, over HTTP: commands as plain requests, and a session's
//! stream read live with the Durable Streams protocol (SSE mode).
//!
//! Everything here blocks; callers run it on background threads.

use std::fmt;
use std::io::BufReader;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::sse;
use crate::wire::{
    IncomingChunk, Offset, Session, SessionCreate, SessionId, StartTurn, StreamControl, Turn,
};

/// Why a request failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// The server answered with an error; `tag` is its `_tag` when it sent one.
    Api { status: u16, tag: Option<String> },
    /// The request never got an answer we could read.
    Transport(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Api { tag: Some(tag), .. } => f.write_str(match tag.as_str() {
                "TurnInProgress" => "a turn is already running",
                "TurnNotRunning" => "no turn is running",
                "SessionNotFound" => "no such session",
                "RequestInvalid" => "the server rejected the request",
                other => other,
            }),
            ApiError::Api { status, tag: None } => write!(f, "the server failed ({status})"),
            ApiError::Transport(reason) => write!(f, "cannot reach the server: {reason}"),
        }
    }
}

impl std::error::Error for ApiError {}

impl From<ureq::Error> for ApiError {
    fn from(error: ureq::Error) -> Self {
        ApiError::Transport(error.to_string())
    }
}

/// What a live read reports.
#[derive(Debug, Clone)]
pub enum LiveUpdate {
    /// Reading (again): everything from the requested offset follows.
    Connected,
    /// Chunks appended to the stream, and the offset just past them.
    Chunks {
        chunks: Vec<IncomingChunk>,
        next: Offset,
    },
    /// The connection dropped; reading resumes from the last offset.
    Disconnected(ApiError),
}

/// How long to wait before reconnecting, doubling after each failure.
const FIRST_RETRY: Duration = Duration::from_millis(250);
const MAX_RETRY: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct ApiClient {
    base: String,
    agent: ureq::Agent,
}

impl ApiClient {
    pub fn new(base: impl Into<String>) -> Self {
        let config = ureq::Agent::config_builder()
            // ApiError responses carry typed bodies; read them rather than fail.
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(5)))
            .build();
        ApiClient {
            base: base.into().trim_end_matches('/').to_owned(),
            agent: config.into(),
        }
    }

    /// Every session, most recently used first.
    ///
    /// # Errors
    /// A transport error, or the server's.
    pub fn list_sessions(&self) -> Result<Vec<Session>, ApiError> {
        let response = self.agent.get(&format!("{}/sessions", self.base)).call()?;
        into_result(response)?
            .into_body()
            .read_json()
            .map_err(ApiError::from)
    }

    /// # Errors
    /// `SessionNotFound` (404) for an unknown session, or a transport error.
    pub fn get_session(&self, session: &SessionId) -> Result<Session, ApiError> {
        let response = self
            .agent
            .get(&format!("{}/sessions/{}", self.base, session.0))
            .call()?;
        into_result(response)?
            .into_body()
            .read_json()
            .map_err(ApiError::from)
    }

    /// # Errors
    /// A transport error, or the server's.
    pub fn create_session(&self, title: &str) -> Result<Session, ApiError> {
        let title = title
            .try_into()
            .map_err(|_| ApiError::Transport(format!("invalid session title: {title:?}")))?;
        self.post("/sessions", &SessionCreate { title })
    }

    /// Starts a turn. Its progress arrives through [`ApiClient::follow_stream`].
    ///
    /// # Errors
    /// `TurnInProgress` (409) while another turn runs, `SessionNotFound` (404),
    /// or a transport error.
    pub fn start_turn(&self, session: &SessionId, turn: &StartTurn) -> Result<Turn, ApiError> {
        self.post(&format!("/sessions/{}/turns", session.0), turn)
    }

    /// Cancels the session's running turn.
    ///
    /// # Errors
    /// `TurnNotRunning` (409) when there is nothing to cancel, or a transport error.
    pub fn cancel_turn(&self, session: &SessionId) -> Result<(), ApiError> {
        let response = self
            .agent
            .post(&format!("{}/sessions/{}/cancel", self.base, session.0))
            .send_empty()?;
        into_result(response).map(drop)
    }

    /// Reads the session's stream from `from`, live, until `on_update` returns
    /// `false` or the session is gone. Reconnects (from the last offset) when
    /// the connection drops or the server rotates it.
    pub fn follow_stream(
        &self,
        session: &SessionId,
        mut from: Offset,
        mut on_update: impl FnMut(LiveUpdate) -> bool,
    ) {
        let mut cursor: Option<String> = None;
        let mut retry = FIRST_RETRY;
        loop {
            match self.read_live(session, &mut from, &mut cursor, &mut on_update) {
                Ok(LiveRead::ServerClosed) => retry = FIRST_RETRY,
                Ok(LiveRead::Stopped) | Err(ApiError::Api { status: 404, .. }) => return,
                Err(error) => {
                    if !on_update(LiveUpdate::Disconnected(error)) {
                        return;
                    }
                    thread::sleep(retry);
                    retry = (retry * 2).min(MAX_RETRY);
                }
            }
        }
    }

    /// One SSE connection: delivers each event's chunks once the control event after them arrives.
    fn read_live(
        &self,
        session: &SessionId,
        from: &mut Offset,
        cursor: &mut Option<String>,
        on_update: &mut impl FnMut(LiveUpdate) -> bool,
    ) -> Result<LiveRead, ApiError> {
        // Query parameters in lexicographic order, as the protocol recommends (§10.1).
        let mut request = self
            .agent
            .get(&format!("{}/sessions/{}/stream", self.base, session.0));
        if let Some(cursor) = cursor.as_deref() {
            request = request.query("cursor", cursor);
        }
        let response = into_result(
            request
                .query("live", "sse")
                .query("offset", &from.0)
                .call()?,
        )?;
        if !on_update(LiveUpdate::Connected) {
            return Ok(LiveRead::Stopped);
        }

        let mut chunks = Vec::new();
        for event in sse::events(BufReader::new(response.into_body().into_reader())) {
            let event = event.map_err(|error| ApiError::Transport(error.to_string()))?;
            match event.event.as_str() {
                "data" => chunks.extend(parse_event::<Vec<IncomingChunk>>(&event.data)?),
                "control" => {
                    let control: StreamControl = parse_event(&event.data)?;
                    from.clone_from(&control.stream_next_offset);
                    cursor.clone_from(&control.stream_cursor);
                    let update = LiveUpdate::Chunks {
                        chunks: std::mem::take(&mut chunks),
                        next: control.stream_next_offset,
                    };
                    if !on_update(update) || control.stream_closed == Some(true) {
                        return Ok(LiveRead::Stopped);
                    }
                }
                _ => {}
            }
        }
        Ok(LiveRead::ServerClosed)
    }

    fn post<B: Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T, ApiError> {
        let response = self
            .agent
            .post(&format!("{}{path}", self.base))
            .send_json(body)?;
        into_result(response)?
            .into_body()
            .read_json()
            .map_err(ApiError::from)
    }
}

/// How a live read ended without an error.
enum LiveRead {
    /// The server closed the connection, as it does every minute or so.
    ServerClosed,
    /// The reader asked to stop, or the stream is closed for good.
    Stopped,
}

/// The response, if it succeeded; its error otherwise.
fn into_result(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<ureq::http::Response<ureq::Body>, ApiError> {
    let status = response.status().as_u16();
    if status < 400 {
        return Ok(response);
    }
    let tag = response
        .body_mut()
        .read_json::<serde_json::Value>()
        .ok()
        .and_then(|body| body.get("_tag")?.as_str().map(str::to_owned));
    Err(ApiError::Api { status, tag })
}

fn parse_event<T: DeserializeOwned>(data: &str) -> Result<T, ApiError> {
    serde_json::from_str(data)
        .map_err(|error| ApiError::Transport(format!("unreadable event: {error}")))
}
