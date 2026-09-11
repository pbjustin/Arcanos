-- Revoke access by removing only Phase 2 requester-device authentication state.
DROP TABLE IF EXISTS gpt_access_device_pairings;
DROP TABLE IF EXISTS gpt_access_devices;
