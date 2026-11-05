CREATE TABLE service_credentials (
 credentialId TEXT PRIMARY KEY, clientId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('CMS','MINIGAME','OPERATOR')),
 tokenHash TEXT NOT NULL UNIQUE, permissions TEXT NOT NULL CHECK(json_valid(permissions)), sites TEXT NOT NULL CHECK(json_valid(sites)),
 scopes TEXT NOT NULL CHECK(json_valid(scopes)), revokedAt INTEGER, createdAt INTEGER NOT NULL
);
CREATE TABLE devices (
 deviceId TEXT PRIMARY KEY, name TEXT NOT NULL, siteId TEXT NOT NULL, doorId TEXT NOT NULL, scopeId TEXT NOT NULL,
 checkInEnabled INTEGER NOT NULL DEFAULT 1 CHECK(checkInEnabled IN(0,1)), generation INTEGER NOT NULL DEFAULT 0,
 credentialHash TEXT UNIQUE, pairedAt INTEGER, confirmedAt INTEGER, configRevision INTEGER NOT NULL DEFAULT 1,
 qrBaseUrl TEXT NOT NULL, appliedRevision INTEGER NOT NULL DEFAULT 0, firmwareTarget TEXT,
 bootId TEXT, currentSession TEXT, sessionEpoch INTEGER NOT NULL DEFAULT 0, hardwareTarget TEXT, firmwareVersion TEXT, buildId TEXT, otaSlotBytes INTEGER, reportedHealthy INTEGER NOT NULL DEFAULT 0,
 capabilities TEXT NOT NULL DEFAULT '[]', lastSeenAt INTEGER, createdAt INTEGER NOT NULL, deletedAt INTEGER
);
CREATE INDEX devices_site ON devices(siteId,scopeId,deviceId);
CREATE TABLE qr_keys (
 keyId TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES devices(deviceId), generation INTEGER NOT NULL,
 publicKey TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('ACTIVE','PENDING','REVOKED')), operationId TEXT, createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_active_key ON qr_keys(deviceId,generation) WHERE state='ACTIVE';
CREATE UNIQUE INDEX one_candidate ON qr_keys(operationId) WHERE state='PENDING';
CREATE TABLE pairings (
 pairingId TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES devices(deviceId), codeHash TEXT NOT NULL, nonce TEXT NOT NULL,
 generation INTEGER NOT NULL, expiresAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN('PENDING','CONSUMED','CANCELLED','LOCKED')), createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_pending_pairing ON pairings(deviceId) WHERE state='PENDING';
CREATE TABLE idempotency (
 clientId TEXT NOT NULL, key TEXT NOT NULL, action TEXT NOT NULL, fingerprint TEXT NOT NULL,
 response TEXT NOT NULL CHECK(json_valid(response)), status INTEGER NOT NULL, PRIMARY KEY(clientId,key)
);
CREATE TABLE operations (
 operationId TEXT PRIMARY KEY, deviceId TEXT NOT NULL REFERENCES devices(deviceId), generation INTEGER NOT NULL,
 action TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN('ADMIN','LOCAL')), state TEXT NOT NULL,
 createdAt INTEGER NOT NULL, deadline INTEGER NOT NULL, ackDeadline INTEGER NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)), result TEXT, actorId TEXT NOT NULL, clientId TEXT NOT NULL
);
CREATE UNIQUE INDEX one_mutation ON operations(deviceId,generation) WHERE action!='REQUEST_STATUS' AND state IN('CREATED','SENT','ACKNOWLEDGED','RUNNING','UNKNOWN');
CREATE TABLE device_events (
 deviceId TEXT NOT NULL, generation INTEGER NOT NULL, eventId TEXT NOT NULL, fingerprint TEXT NOT NULL,
 type TEXT NOT NULL, operationId TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(deviceId,generation,eventId)
);
CREATE TABLE audit (
 eventId TEXT PRIMARY KEY, deviceId TEXT, siteId TEXT, scopeId TEXT, clientId TEXT NOT NULL,
 actorId TEXT NOT NULL, action TEXT NOT NULL, createdAt INTEGER NOT NULL, detail TEXT NOT NULL, actorName TEXT
);
CREATE INDEX audit_device ON audit(deviceId,eventId);
CREATE TABLE publisher_keys (keyId TEXT PRIMARY KEY, publicKey TEXT NOT NULL, revokedAt INTEGER);
CREATE TABLE firmware_releases (
 releaseId TEXT PRIMARY KEY, buildId TEXT NOT NULL UNIQUE, hardwareTarget TEXT NOT NULL, version TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>0 AND size<=8388608), sha256 TEXT NOT NULL, publisherKeyId TEXT NOT NULL REFERENCES publisher_keys(keyId),
 signature TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('UPLOADING','DRAFT','APPROVED','REVOKED')),
 verified INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, UNIQUE(hardwareTarget,version)
);
CREATE TABLE qr_policy (id INTEGER PRIMARY KEY CHECK(id=1), maxAgeMs INTEGER NOT NULL CHECK(maxAgeMs BETWEEN 30000 AND 60000), futureSkewMs INTEGER NOT NULL CHECK(futureSkewMs BETWEEN 0 AND 5000));
INSERT INTO qr_policy VALUES(1,60000,5000);
CREATE TABLE check_ins (
 checkInId TEXT PRIMARY KEY, clientId TEXT NOT NULL, subjectId TEXT NOT NULL, scopeId TEXT NOT NULL,
 deviceId TEXT NOT NULL REFERENCES devices(deviceId), siteId TEXT NOT NULL, qrIssuedAtMs INTEGER NOT NULL, verifiedAtMs INTEGER NOT NULL, subjectName TEXT
);
CREATE INDEX checkins_latest ON check_ins(clientId,subjectId,scopeId,verifiedAtMs DESC,checkInId DESC);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE transaction_guard (ok INTEGER NOT NULL CHECK(ok=1));

CREATE TABLE device_presence (
 deviceId TEXT PRIMARY KEY REFERENCES devices(deviceId), generation INTEGER NOT NULL,
 sessionId TEXT, state TEXT NOT NULL CHECK(state IN('ONLINE','OFFLINE')), observedAt INTEGER NOT NULL
);
CREATE TABLE operation_progress (
 operationId TEXT PRIMARY KEY REFERENCES operations(operationId), percent INTEGER NOT NULL CHECK(percent BETWEEN 0 AND 100), updatedAt INTEGER NOT NULL
);
CREATE INDEX operations_recent ON operations(deviceId,createdAt DESC,operationId DESC);
CREATE INDEX audit_filter ON audit(createdAt,deviceId,action);

CREATE TABLE time_settings (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 server TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh'
);
INSERT INTO time_settings VALUES(1,1,'vn.pool.ntp.org','Asia/Ho_Chi_Minh');
CREATE TABLE device_network_config (
 deviceId TEXT PRIMARY KEY REFERENCES devices(deviceId), ssid TEXT NOT NULL,
 passwordCipher TEXT NOT NULL
);
CREATE TABLE device_runtime_status (
 deviceId TEXT PRIMARY KEY REFERENCES devices(deviceId), generation INTEGER NOT NULL,
 sessionId TEXT NOT NULL, observedAt INTEGER NOT NULL,
 runtimeConfigVersion INTEGER, wifiSsid TEXT, timeReport TEXT
);

CREATE TABLE device_registrations (
 registrationId TEXT PRIMARY KEY, siteId TEXT NOT NULL, scopeId TEXT NOT NULL,
 publicKey TEXT NOT NULL, keyId TEXT NOT NULL, hardwareTarget TEXT NOT NULL, serial TEXT,
 nonce TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('CHALLENGE','COMPLETED','LOCKED','EXPIRED')),
 attempts INTEGER NOT NULL DEFAULT 0, deviceId TEXT REFERENCES devices(deviceId),
 createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
);
CREATE INDEX registrations_scope ON device_registrations(siteId,scopeId,state,registrationId);
