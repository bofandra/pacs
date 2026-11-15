# PACS Native — Node.js

Native PACS prototype: an original Node.js server, PostgreSQL catalog, content-addressed DICOM storage, DICOMweb HTTP API, and optional native DCMTK-backed DIMSE ingress/client adapters. **Not an Orthanc/dcm4chee wrapper.**

> ⚠️ **Development / research only — NOT FOR CLINICAL USE.** Repository was empty before this initial implementation. The prior 8/8 chat checklist has **not** been independently verified against code or DICOM test evidence. See [implementation status](docs/STATUS.md).

## Getting started (synthetic data only)

Requires Node.js 22+, PostgreSQL 17 and, for DIMSE, compatible `dicom-dimse-native` binaries.

```bash
cp .env.example .env
# Edit .env to set a long API_TOKEN and correct database credentials
docker compose up -d postgres
npm install
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js
```

In separate shells, for DIMSE C-STORE inbox and indexing:

```bash
node --env-file=.env src/inbox-worker.js
node --env-file=.env src/dimse-scp.js
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
| GET | /api/v1/aes | Listed AE nodes |
| PUT | /api/v1/aes/{AET} | Register or update peer AE |
| POST | /api/v1/dimse/{find\|move\|get} | C-FIND/MOVE/GET SCU against registered peer |
| GET | /api/v1/audit | Basic ingest event log |

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

`npm test` runs small unit tests. CI runs syntax checks, unit tests and a synthetic DICOM STOW/QIDO/WADO roundtrip against PostgreSQL. It **does not** prove DIMSE interoperability, OHIF, complete DICOM conformance, or clinical safety.

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

Original Part 10 files are preserved; ingestion rejects an existing SOP Instance UID with different SHA-256 bytes. STOW parses `multipart/related` but is a protocol subset, not a certified implementation.

Known gaps: WADO metadata is incomplete, frame endpoints and pixel-data bulk retrieval aren't implemented, C-FIND/MOVE/GET **SCP** and MWL are not implemented, OHIF is not connected, and the asynchronous inbox worker needs production-grade crash recovery. See [docs/STATUS.md](docs/STATUS.md).

## License and third-party dependencies

Proprietary/prototype status pending a license decision. Dependency licenses are separate: dicom-dimse-native is MIT. This repository does not bundle DCMTK or any patient data.
