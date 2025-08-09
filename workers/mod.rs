mod worker_manager;

pub use worker_manager::{list_workers, register_worker, WorkerInfo};

pub fn start_workers() {
    worker_manager::start_workers();
}
