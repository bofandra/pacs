# Implementation status and DICOM conformance gaps

**Prototype only — NOT FOR CLINICAL USE.** Checklist assertions supplied in a chat are not test evidence.

| Capability | Implementation in this branch | Verification |
| --- | --- | --- |
| C-ECHO SCP | Native addon startStoreScp listener configured | Integration test required |
| C-STORE SCP | Native addon writes incoming instances to inbox | Integration test required |
| Metadata indexing | PostgreSQL schema + inbox ingestion | Synthetic STOW indexing CI passed; DIMSE inbox still unverified |
| Immutable storage + SHA-256 | Content-addressed filesystem files | Unit tests supplied |
| QIDO-RS studies/series/instances | Query endpoints | Synthetic HTTP/PostgreSQL integration passed; conformance tests required |
| WADO-RS instance retrieval | multipart/related full DICOM instance | Synthetic byte-for-byte retrieval CI passed; client tests required |
| WADO-RS metadata | Selected attributes (subset) | Not yet viewer-conformant |
| STOW-RS | multipart/related application/dicom | Synthetic multipart ingest CI passed; partial STOW status semantics |
| OHIF rendering | **NOT IMPLEMENTED / NOT VERIFIED** | Requires complete metadata/frames and viewer config |
| Duplicate and corruption handling | UID collision reject + storage checksum | Unit tests + synthetic UID collision passed; concurrency tests required |
| AE registry | PostgreSQL CRUD (protected HTTP API) | Synthetic HTTP/PostgreSQL integration passed |
| C-FIND/C-MOVE/C-GET SCU | Native addon adapter to allowlisted registered AE | DICOM simulator tests required |
| Study Root C-FIND SCP | Experimental PostgreSQL-backed STUDY/SERIES/IMAGE matching with AE+IP allowlist, loopback-only | JavaScript DIMSE client + DCMTK findscu CI passed; conformance/security tests outstanding |\n| C-MOVE/C-GET SCP | **NOT IMPLEMENTED** — presentation contexts rejected | Must implement correct C-STORE sub-operations and role negotiation |
| DICOM Modality Worklist SCP | **NOT IMPLEMENTED** | Native MWL support not available in selected addon |
| DICOM routing | Automatic per-modality routing rules, persistent jobs, retries, dead-letter, audit, optional native C-STORE SCU worker | Synthetic PostgreSQL/worker integration passed; no network peer validation |
| Backup/restore, TLS, RBAC, consent | **NOT IMPLEMENTED** | Needed before clinical use |

## P1 routing progress

- Automatic routing only applies to **newly ingested** DICOM instances. Existing studies require manual enqueue.
- Route must be explicitly enabled. Destination AE must exist and be enabled.
- Jobs are unique per SOP Instance UID and destination AE; duplicate ingest does not enqueue a second job.
- Worker uses a DB lease and exponential backoff with dead-letter state, and isolates the optional native C-STORE SCU in a child process.
- At-least-once behavior: lease expiry or crash after remote acknowledgment can cause a repeat C-STORE; destination MUST handle identical SOP Instance UID consistently.
- No guarantee of clinical-grade delivery, caller AE authentication, encryption, backup/restore, or full DICOM conformance.
- See [routing guide](ROUTING.md).

## C-FIND Query/Retrieve progress

- A separate Node.js DICOM Study Root **C-FIND SCP** now reads the same PostgreSQL `studies`, `series` and `instances` tables as the existing DICOMweb API.
- Supports Study/Series/Image levels with a bounded 100-result limit; parameterized wildcard matches, StudyDate ranges and mandatory hierarchy UIDs at lower levels.
- Explicit startup gate `PACS_FIND_EXPERIMENTAL=1`, loopback-only TCP listener, registered enabled IPv4 AE + remote address check and called AE match; restart required after registry updates.
- The server rejects C-MOVE/C-GET presentation contexts — there is **no implemented retrieval SCP service** yet.
- Independent DCMTK findscu integration succeeded on a synthetic CR study. See [docs/FIND_SCP.md](FIND_SCP.md).

## Verified automated evidence

- GitHub Actions initial core: https://github.com/bofandra/pacs/actions/runs/43686423562 (commit a6a41a81)
- GitHub Actions routing integration: https://github.com/bofandra/pacs/actions/runs/43691572537 (commit 1124c744)
- GitHub Actions C-FIND SCP + DCMTK: https://github.com/bofandra/pacs/actions/runs/43696156648 (commit c5b07b1a, 12/12 tests passed)
- Node.js syntax check, unit tests, PostgreSQL migration, synthetic Part 10 DICOM parsing, HTTP STOW/QIDO/WADO roundtrip, checksum, duplicate/UID collision rejection and AE registry passed.
- Routing CI validates atomic queueing, a mock-send worker, retry/backoff, dead-letter and replay. The native network transfer is **not** covered by CI.
- **Not verified:** C-STORE/C-ECHO ingress from a DICOM simulator; C-MOVE/C-GET SCP; C-FIND/MOVE/GET SCU with external peers; MWL; OHIF; clinical rendering. C-FIND SCP is verified only with a narrow set of synthetic queries.

Backlog: [DIMSE SCP](https://github.com/bofandra/pacs/issues/2), [MWL](https://github.com/bofandra/pacs/issues/3), [routing](https://github.com/bofandra/pacs/issues/4), [OHIF](https://github.com/bofandra/pacs/issues/5).

## Safety requirements before clinical pilot

- Configure private DICOM subnets, firewalls and AE allowlists on the network layer; the sample native listener is not evidence of enforced caller-AE authorization.
- Use test/synthetic DICOM only. No patient data in GitHub, examples, CI, or public issue/PR.
- Run C-ECHO and C-STORE from DCMTK tools and verify DB/index/storage; verify delayed worker indexing and crash recovery.
- Add database migrations discipline, migration rollback, durable queue, storage fsync/directory sync, backup and checksum scrubbing.
- Add transport encryption, robust authentication/authorization, data retention and immutable audit access logs.
- Document all supported SOP Classes and Transfer Syntaxes and test compressed/multiframe studies.
- Prepare formal DICOM PS3.2 Conformance Statement after verified tests; this document is **not** a formal conformance claim.

References:
- DICOM PS3.18: https://dicom.nema.org/medical/dicom/current/output/html/part18.html
- DICOM PS3.2: https://dicom.nema.org/medical/dicom/current/output/html/part02.html
- DIMSE native adapter: https://github.com/knopkem/dicom-dimse-native
