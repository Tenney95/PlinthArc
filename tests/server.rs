use plintharc::server::{LocalServer, ServerConfig};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

#[test]
fn arc_settings_are_local_and_survive_a_server_restart() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let ui_dir = root.join("ui");
    fs::create_dir(&ui_dir).unwrap();
    fs::write(ui_dir.join("index.html"), "<title>Arc</title>").unwrap();
    let config = || ServerConfig {
        ui_dir: ui_dir.clone(),
        data_dir: root.join("data"),
        engine: None,
        port: 0,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let server = LocalServer::bind(config()).unwrap();
    let origin = server.origin().to_owned();
    let running = runtime.spawn(server.run());

    let body = json!({
        "model_dir": root,
        "output_dir": root,
        "backend": "CPU",
        "engine": root.join("untrusted executable")
    })
    .to_string();
    let api = "/api/v1/settings";
    let settings = |origin_header: &str| {
        format!(
            "PUT {api} HTTP/1.1\r\nOrigin: {origin_header}\r\nContent-Type: application/json\r\nContent-Length: {}",
            body.len()
        )
    };
    let rejected = send(&origin, &settings("https://foreign.test"), &body);
    assert!(rejected.starts_with("HTTP/1.1 403"), "{rejected}");
    assert!(send(&origin, "GET / HTTP/1.1", "").ends_with("<title>Arc</title>"));
    let saved = send(&origin, &settings(&origin), &body);
    assert!(saved.starts_with("HTTP/1.1 200"), "{saved}");
    assert_eq!(response_json(&saved)["engine"], "");

    running.abort();
    assert!(runtime.block_on(running).is_err());
    let server = LocalServer::bind(config()).unwrap();
    let origin = server.origin().to_owned();
    let running = runtime.spawn(server.run());
    let response = send(&origin, &format!("GET {api} HTTP/1.1"), "");
    let persisted = response_json(&response);
    assert_eq!(persisted["model_dir"], json!(root));
    assert_eq!(persisted["output_dir"], json!(root));
    assert_eq!(persisted["backend"], "CPU");
    running.abort();
}

fn send(origin: &str, request_line: &str, body: &str) -> String {
    let host = origin.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(host).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        stream,
        "{request_line}\r\nHost: {host}\r\nConnection: close\r\n\r\n{body}"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn response_json(response: &str) -> Value {
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    serde_json::from_str(body).unwrap()
}
