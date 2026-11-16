# PACS Native — Node.js

Native PACS prototype: an original Node.js server, PostgreSQL catalog, content-addressed DICOM storage, DICOMweb HTTP API, and optional native DCMTK-backed DIMSE ingress/client adapters. **Not an Orthanc/dcm4chee wrapper.**

> ⚠️ **Development / research only — NOT FOR CLINICAL USE.** Repository was empty before this initial implementation. The prior 8/8 chat checklist has **not** been independently verified against code or DICOM test evidence. See [implementation status](docs/STATUS.md).

## Getting started (synthetic data only)

Requires Node.js 22+ and PostgreSQL 17. Experimental C-FIND/C-MOVE use the JavaScript `dcmjs-dimse` adapter; the separate C-STORE ingress listener and earlier DIMSE SCU helpers may require compatible native `dicom-dimse-native` binaries.

```bash
cp .env.example .env
# Edit .env to set a long API_TOKEN and correct database credentials
docker compose up -d postgres
npm install
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js
```

In separate shells, for the legacy native DIMSE C-STORE inbox (not network-verified) and indexing:

```bash
node --env-file=.env src/inbox-worker.js
node --env-file=.env src/dimse-scp.js

# Alternative validated C-ECHO/C-STORE listener (do NOT start both on port 11112):
PACS_STORE_EXPERIMENTAL=1 node --env-file=.env src/store-scp.js

# Experimental Study Root FIND SCP: separate local listener (port 11115).
# Requires enabled peer AE registry before start; restart to reload registry.
PACS_FIND_EXPERIMENTAL=1 node --env-file=.env src/find-scp.js

# To enable C-MOVE and C-GET (synthetic DICOM, loopback-only):
PACS_FIND_EXPERIMENTAL=1 PACS_MOVE_EXPERIMENTAL=1 PACS_GET_EXPERIMENTAL=1 \
 node --env-file=.env src/find-scp.js

# Experimental DICOM Modality Worklist SCP (separate 127.0.0.1:11116 listener):
PACS_MWL_EXPERIMENTAL=1 node --env-file=.env src/mwl-scp.js

# Optional: P1 delivery/routing worker, for synthetic peer testing only
node --env-file=.env src/delivery-worker.js
```

The HTTP server defaults to **127.0.0.1:3000** and DIMSE to **127.0.0.1:11112**. No service should be exposed directly to public networks. Every HTTP endpoint except `GET /health` requires `Authorization: Bearer <API_TOKEN>`.

## API endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | /health | HTTP liveness only; not DB readiness |
| POST | /dicomweb/studies | STOW-RS multipart/related with application/dicom parts |
| GET | /dicomweb/studies | QIDO-RS study search (PatientID, StudyInstanceUID, AccessionNumber, StudyDate) |
| GET | /dicomweb/studies/{study}/series | QIDO-RS series |
| GET | /dicomweb/studies/{study}/series/{series}/instances | QIDO-RS instances |
| GET | /dicomweb/studies/{study}/metadata | Basic WADO-RS metadata subset |
| GET | /dicomweb/studies/{study}/series/{series}/metadata | Series metadata subset |
| GET | /dicomweb/studies/{study}/series/{series}/instances/{instance}/metadata | Instance metadata subset |
| GET | /dicomweb/studies/{study}/series/{series}/instances/{instance} | Full DICOM object in multipart/related |
| GET | /dicomweb/studies/{study}/series/{series}/instances/{instance}/frames/{list} | Uncompressed WADO-RS frames (multipart octet-stream) |
| GET | /dicomweb/studies/{study}/series/{series}/instances/{instance}/bulkdata/7fe00010 | WADO-RS PixelData BulkDataURI |
| POST | /api/v1/ris/worklist-orders | Create an idempotent RIS order + scheduled procedure step |
| GET | /api/v1/ris/worklist-orders | List orders (stationAet/status filters) |
| GET | /api/v1/ris/worklist-orders/{id} | Return one order |
| PATCH | /api/v1/ris/worklist-orders/{id}/status | Mark scheduled/on_hold/completed/cancelled (validated transitions) |
| GET | /api/v1/ris/worklist-orders/{id}/reconciliation | Compare ingested study against RIS identifiers (advisory only) |
| GET | /api/v1/aes | Listed AE nodes |
| PUT | /api/v1/aes/{AET} | Register or update peer AE |
| POST | /api/v1/dimse/{find\|move\|get} | C-FIND/MOVE/GET SCU against registered peer |
| GET | /api/v1/routing/rules | List automatic routing rules |
| POST | /api/v1/routing/rules | Add route (disabled by default) |
| PATCH | /api/v1/routing/rules/{id} | Enable/disable route |
| GET | /api/v1/delivery/jobs | List delivery jobs (status filter optional) |
| POST | /api/v1/delivery/jobs | Idempotently enqueue one SOP Instance to an AE |
| POST | /api/v1/delivery/jobs/{id}/retry | Requeue a dead-lettered job |
| GET | /api/v1/delivery/stats | Delivery counters by state |
| GET | /api/v1/audit | Ingest + delivery status audit events |

Example:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
 "http://127.0.0.1:3000/dicomweb/studies?PatientID=TEST001"
```

Register a synthetic DICOM peer:

```bash
curl -X PUT http://127.0.0.1:3000/api/v1/aes/SIMULATOR \
 -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
 -d '{"host":"127.0.0.1","port":11114,"enabled":true}'
```

C-FIND as SCU (requires native package and a simulator at registered AE):

```bash
curl -X POST http://127.0.0.1:3000/api/v1/dimse/find \
 -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
 -d '{"aet":"SIMULATOR","studyUID":"1.2.840.10008.1.2.3"}'
```

`npm test` runs unit tests. The CI suite adds PostgreSQL, synthetic DICOM STOW/QIDO/WADO, delivery rule and retry tests, and independent DCMTK checks for C-ECHO, C-STORE, C-FIND, C-MOVE, C-GET, and MWL. The network scenarios include multi-instance C-MOVE, receiver rejection and retry, and an MWL date/time range across midnight. Device interoperability, full DICOM conformance, and clinical use require separate validation.

## Scope / architecture

```text
Modalities --DIMSE C-STORE--> optional native SCP --> inbox/
                                                 |
                                            inbox worker
                                                 v
DICOMweb STOW --> Node.js Fastify --> DICOM parser --> PostgreSQL index
                                           |                |
                                           v                v
                                    SHA-256 objects    QIDO-RS / WADO-RS
                                           |
                                        raw DICOM
```

Original Part 10 files are preserved; ingestion rejects an existing SOP Instance UID with different SHA-256 bytes. STOW parses `multipart/related` but is a protocol subset, not a certified implementation. Delivery worker is at-least-once (remote destination should handle repeated SOP Instance UID idempotently), not exactly-once.

[Routing and delivery guide](docs/ROUTING.md) covers AE setup, automatic rules, manual enqueue, test commands and retry semantics.

Study Root C-FIND SCP is implemented as a separate **experimental loopback-only** service with database-backed STUDY/SERIES/IMAGE responses. Optional C-MOVE SCP sends verified Part 10 instances to an explicitly registered loopback destination using C-STORE suboperations and responds with completed/failed counters. The calling AE and destination AE must be enabled in the registry when the listener starts. See [C-FIND guide](docs/FIND_SCP.md) and [C-MOVE guide](docs/MOVE_SCP.md). C-GET SCP is separately opt-in and sends C-STORE suboperations on the **same association** only when reverse SCP role is negotiated. See [C-GET guide](docs/GET_SCP.md).

A standalone [Modality Worklist SCP](docs/MWL_SCP.md) on 127.0.0.1:11116 now reads scheduled RIS orders from PostgreSQL (not imaging metadata) and returns DICOM `ScheduledProcedureStepSequence`; it is gated by `PACS_MWL_EXPERIMENTAL=1`. The RIS API requires issuer-qualified Patient IDs and accession references; a reconciliation endpoint reports matching evidence without automatically merging patients.

The [OHIF loopback development viewer](docs/WADO_OHIF.md) uses uncompressed WADO-RS frames and DICOM JSON metadata. OHIF 3.11.0 rendered a synthetic CR image in Chrome. The separate JavaScript C-STORE SCP indexes objects before confirming Success. See the [inbound C-STORE guide](docs/STORE_SCP.md).

Open work includes compressed WADO frames and metadata conformance, remote/TLS DIMSE security, full DICOM MWL conformance, shared viewer authorization, and asynchronous inbox recovery. See [docs/STATUS.md](docs/STATUS.md).

## License and third-party dependencies

Proprietary/prototype status pending a license decision. Dependency licenses are separate: dicom-dimse-native is MIT. This repository does not bundle DCMTK or any patient data.
