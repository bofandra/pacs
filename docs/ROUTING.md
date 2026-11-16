# DICOM Routing & Delivery (P1 prototype)

This implements an original Node.js/PostgreSQL routing control plane and delivery worker, rather than using Orthanc/dcm4chee as a PACS service.

**Research/testing only. Do not ingest identifiable patient data.**

## How it works

```text
New C-STORE / STOW ingest
    -> parse and persist Part 10 DICOM
    -> transaction inserts new instance index
    -> enabled routing_rules match modality (e.g. CR)
    -> delivery_jobs created idempotently per (instance_uid, destination_aet)
    -> delivery worker leases one job (SKIP LOCKED)
    -> checks SHA-256 and stages one DICOM file in an isolated temp directory
    -> C-STORE SCU subprocess sends to registered AE and checks its response
    -> success, queued retry with backoff, or dead_letter + audit event
```

The worker reclaims expired leases. A network acknowledgment followed by worker crash can cause repeat delivery: this is **at-least-once**, not exactly-once. Duplicate SOP UIDs must be accepted idempotently by the destination. Ingestion does not wait for remote delivery.

## Prepare (synthetic studies only)

```bash
npm install
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js
# Separate terminal:
node --env-file=.env src/delivery-worker.js
```

The delivery subprocess uses dcmjs-dimse and acknowledges a job after a C-STORE Success response. The previous native addon returned success even after a receiver rejected an instance. Integration tests exercise delivery to DCMTK storescp and a receiver that returns failure before accepting the retry.

All API calls below require the development-only Bearer token:

```bash
export BASE=http://127.0.0.1:3000
export AUTH="Authorization: Bearer ${API_TOKEN}"
```

1. Register a destination AE (for testing, a separately launched DCMTK storescp on 127.0.0.1:11114):

```bash
curl -X PUT "$BASE/api/v1/aes/TEST_SCP" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"host":"127.0.0.1","port":11114,"enabled":true}'
```

2. Create a route matching **CR** studies (new routes are disabled by default):

```bash
curl -X POST "$BASE/api/v1/routing/rules" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"destinationAet":"TEST_SCP","modality":"CR"}'
# Response includes an integer 'id'. Enable it explicitly after peer validation:
curl -X PATCH "$BASE/api/v1/routing/rules/1" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

Use `modality:null` to match all modalities; avoid enabling this until authorization and routing policies are reviewed.

3. STOW a new synthetic CR DICOM object or send it via C-STORE, then inspect:

```bash
curl -H "$AUTH" "$BASE/api/v1/delivery/jobs?status=queued"
curl -H "$AUTH" "$BASE/api/v1/delivery/stats"
curl -H "$AUTH" "$BASE/api/v1/audit?limit=20"
```

4. Manually enqueue an existing SOP Instance UID (does not require a matching route):

```bash
curl -X POST "$BASE/api/v1/delivery/jobs" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"instanceUID":"2.25.123456789","destinationAet":"TEST_SCP"}'
```

5. A job that reaches `dead_letter` may be explicitly retried after investigating:

```bash
curl -X POST "$BASE/api/v1/delivery/jobs/1/retry" -H "$AUTH"
```

## State transitions

```text
queued --claim--> sending --ack--> succeeded
                   |  |
                   |  +--failure (attempts remain)--> queued (backoff)
                   +--failure (last attempt)-------> dead_letter
                   +--expired lease---------------> reclaim / dead_letter
dead_letter --authorized manual retry-----------> queued
```

Terminal states are never silently retried. Disabling the destination AE prevents new claims; disabling a rule prevents *new job creation* but does not cancel already queued jobs.

## Manual DIMSE interoperability exercise

1. Install DCMTK in an isolated test environment. Start `storescp -aet TEST_SCP -od ./test-received 11114` and ensure its listener is reachable **only** from the PACS worker.
2. Enable the routing rule for CR.
3. Send a **synthetic** CR file to the PACS C-STORE SCP using `storescu -aet SIMULATOR -aec PACS_NATIVE 127.0.0.1 11112 synthetic-cr.dcm`; verify QIDO-RS returns the indexed object and the delivery worker reports success.
4. Compare SOP Instance UID and dataset contents of source and destination. The receiver may reconstruct the Part 10 file header. Review logs and DB delivery state.
5. Shut down destination to test retries and dead-letter handling; restore and use manual retry.
6. Document supported Transfer Syntaxes, presentation contexts, AEs and rejection paths. Validate the actual receiving nodes and network controls independently of the loopback test.

## Current limitations

- Routing matches modality and uses registered AEs. Source-AE matching, operator review controls and network egress enforcement remain open.
- No TLS DIMSE, no caller AE identity enforcement at transport, no per-study routing policy, no cross-site consent checks.
- Rule modification affects future ingestions; old queued jobs are not canceled.
- No automatic retention/backup or replay ledger beyond one delivery row per instance/destination.
- The child uses a single staged DICOM file and one association per delivery. This has throughput overhead.
