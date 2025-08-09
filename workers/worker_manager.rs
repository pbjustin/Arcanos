use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct WorkerInfo {
    pub id: String,
    pub version: String,
    pub registered_at: u64,
}

impl WorkerInfo {
    pub fn new(id: &str, version: Option<&str>) -> Self {
        let version = match version {
            Some(v) if !v.is_empty() => v.to_string(),
            _ => "Uncommitted".to_string(),
        };
        let registered_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs();
        Self { id: id.to_string(), version, registered_at }
    }
}

static WORKERS: OnceLock<Mutex<HashMap<String, WorkerInfo>>> = OnceLock::new();

pub fn start_workers() {
    WORKERS.get_or_init(|| Mutex::new(HashMap::new()));
}

pub fn register_worker(id: &str, version: Option<&str>) {
    start_workers();
    if let Some(map_mutex) = WORKERS.get() {
        let mut map = map_mutex.lock().unwrap();
        let info = WorkerInfo::new(id, version);
        println!(
            "[AUDIT] {} worker registered with version '{}' at {}",
            info.id, info.version, info.registered_at
        );
        map.insert(id.to_string(), info);
    }
}

pub fn list_workers() -> Vec<WorkerInfo> {
    WORKERS
        .get()
        .map(|m| {
            let map = m.lock().unwrap();
            map.values().cloned().collect()
        })
        .unwrap_or_default()
}
