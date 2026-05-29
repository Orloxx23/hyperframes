//! Port selection + readiness probe for the embedded `hyperframes preview` server.
//!
//! Picks an available localhost port from a fixed range (17777..17877), then
//! polls `/__hyperframes_config` until the CLI sidecar responds with
//! `{ "isHyperframes": true }`. The endpoint is defined in the CLI at
//! `packages/cli/src/server/studioServer.ts`.

use anyhow::{bail, Result};
use std::net::TcpListener;
use std::time::Duration;
use tokio::time::sleep;

const PORT_RANGE_START: u16 = 17777;
const PORT_RANGE_END: u16 = 17877;
const READINESS_TIMEOUT_SECS: u64 = 45;
const READINESS_POLL_INTERVAL_MS: u64 = 200;

/// Find an unused port in the well-known HyperFrames desktop range. We pin
/// the range (rather than asking the OS for any free port) so that users can
/// recognize the app's traffic in netstat output and so firewall rules can be
/// scoped predictably.
pub fn find_free_port() -> Result<u16> {
    for port in PORT_RANGE_START..=PORT_RANGE_END {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    bail!(
        "No free port available in range {}..={}",
        PORT_RANGE_START,
        PORT_RANGE_END
    );
}

/// Block until the CLI sidecar responds with a HyperFrames config payload, or
/// the timeout elapses. The endpoint is intentionally a JSON object with a
/// stable shape — see [studioServer.ts `/__hyperframes_config` handler](../../../cli/src/server/studioServer.ts).
pub async fn wait_for_ready(port: u16) -> Result<()> {
    let url = format!("http://127.0.0.1:{port}/__hyperframes_config");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    let deadline = std::time::Instant::now() + Duration::from_secs(READINESS_TIMEOUT_SECS);

    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if json
                        .get("isHyperframes")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        return Ok(());
                    }
                }
            }
        }
        sleep(Duration::from_millis(READINESS_POLL_INTERVAL_MS)).await;
    }

    bail!(
        "Sidecar did not become ready within {READINESS_TIMEOUT_SECS}s (port {port})"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn find_free_port_returns_a_port_in_range() {
        let port = find_free_port().expect("should find a port");
        assert!(port >= PORT_RANGE_START && port <= PORT_RANGE_END);
    }

    #[test]
    fn find_free_port_skips_occupied_ports() {
        // Occupy the first port in the range; the next call should return a different one.
        let listener = TcpListener::bind(("127.0.0.1", PORT_RANGE_START)).unwrap();
        let port = find_free_port().expect("should find a port");
        assert_ne!(port, PORT_RANGE_START);
        drop(listener);
    }
}
