//! End to end against a running server (ignored by default):
//!
//! ```sh
//! cd server
//! bun run fake-anthropic &
//! Q_DB_PATH=:memory: Q_ANTHROPIC_URL=http://127.0.0.1:7778 ANTHROPIC_API_KEY=fake bun run start &
//! cd .. && cargo test --test e2e -- --ignored
//! ```

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use q::api::{ApiClient, ApiError, LiveUpdate};
use q::transcript::Transcript;
use q::wire::{IncomingChunk, Offset, SessionId, StartTurn, TurnEndReason, TurnId};
use uuid::Uuid;

fn api_client() -> ApiClient {
    ApiClient::new(
        std::env::var("Q_SERVER_URL").unwrap_or_else(|_| "http://127.0.0.1:7777".to_owned()),
    )
}

/// The session's stream, read live on a thread: the chunks of each update, as they arrive.
fn follow(api: &ApiClient, session: &SessionId) -> mpsc::Receiver<Vec<IncomingChunk>> {
    let (tx, rx) = mpsc::channel();
    let (api, session) = (api.clone(), session.clone());
    thread::spawn(move || {
        api.follow_stream(&session, Offset("-1".to_owned()), |update| match update {
            LiveUpdate::Chunks { chunks, .. } => tx.send(chunks).is_ok(),
            LiveUpdate::Connected | LiveUpdate::Disconnected(_) => true,
        });
    });
    rx
}

/// Folds the stream into `transcript` until `done` holds.
fn until(
    transcript: &mut Transcript,
    stream: &mpsc::Receiver<Vec<IncomingChunk>>,
    done: impl Fn(&Transcript) -> bool,
) {
    while !done(transcript) {
        let chunks = stream
            .recv_timeout(Duration::from_secs(10))
            .expect("the stream to keep going");
        for chunk in &chunks {
            transcript.apply(chunk);
        }
    }
}

fn start_turn(api: &ApiClient, session: &SessionId, text: &str) -> Result<TurnId, ApiError> {
    let message = StartTurn {
        turn_id: TurnId(Uuid::now_v7()),
        text: text.try_into().unwrap(),
    };
    api.start_turn(session, &message).map(|turn| turn.id)
}

#[test]
#[ignore = "needs a running server"]
fn a_conversation_round_trip() {
    let api = api_client();
    let session = api.create_session("e2e").expect("a session").id;
    let stream = follow(&api, &session);
    let mut transcript = Transcript::default();

    let first = start_turn(&api, &session, "hello from rust").expect("the turn to start");
    until(&mut transcript, &stream, |t| {
        t.turns()
            .last()
            .is_some_and(|turn| turn.id.0 == first.0 && turn.end.is_some())
    });

    let slow = start_turn(&api, &session, "slow please").expect("the second turn to start");
    let too_soon = start_turn(&api, &session, "too soon");
    assert!(
        matches!(too_soon, Err(ApiError::Api { status: 409, tag: Some(ref tag) }) if tag == "TurnInProgress")
    );
    until(&mut transcript, &stream, |t| {
        t.running().is_some_and(|turn| {
            turn.id.0 == slow.0 && turn.reply().is_some_and(|reply| reply.parts.len() > 1)
        })
    });
    api.cancel_turn(&session).expect("the cancel to land");
    until(&mut transcript, &stream, |t| t.running().is_none());

    let turns = transcript.turns();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].text, "hello from rust");
    assert_eq!(turns[0].end, Some(TurnEndReason::Completed));
    let reply = serde_json::to_value(turns[0].reply().expect("a reply")).unwrap();
    assert_eq!(reply["parts"][1]["text"], "Echo: hello from rust");
    assert_eq!(turns[1].end, Some(TurnEndReason::Cancelled));

    // A second reader resuming from the start sees the same conversation.
    let mut replayed = Transcript::default();
    until(&mut replayed, &follow(&api, &session), |t| {
        t.turns().len() == 2 && t.running().is_none()
    });
    assert_eq!(
        serde_json::to_value(replayed.turns()).unwrap(),
        serde_json::to_value(transcript.turns()).unwrap()
    );
}
