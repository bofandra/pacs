# Implementation status and DICOM conformance gaps

**Prototype only — NOT FOR CLINICAL USE.** Checklist assertions supplied in a chat are not test evidence.

| Capability | Implementation in this branch | Verification |
| --- | --- | --- |
| C-ECHO SCP | Experimental JavaScript DIMSE listener plus older native addon listener | DCMTK echoscu success for JavaScript listener; native addon not tested |
| C-STORE SCP | Experimental JavaScript listener validates SOP identity, persists and indexes reconstructed DICOM Part 10 before success; native inbox adapter remains | DCMTK storescu success, duplicate handling, UID collision rejection, unauthorized caller rejection tested; native addon inbox not tested |
| Metadata indexing | PostgreSQL schema + inbox ingestion | Synthetic STOW indexing CI passed; DIMSE inbox still unverified |
| Immutable storage + SHA-256 | Content-addressed filesystem files | Unit tests supplied |
| QIDO-RS studies/series/instances | Query endpoints | Synthetic HTTP/PostgreSQL integration passed; conformance tests required |
| WADO-RS instance retrieval | multipart/related full DICOM instance | Synthetic byte-for-byte retrieval CI passed; client tests required |
| WADO-RS frames / bulkdata | Raw uncompressed 8/16-bit LE frames and PixelData multipart retrieval | Synthetic one- and two-frame network integration passed; compressed not supported |
| WADO-RS metadata | Dynamic DICOM JSON metadata with PixelData BulkDataURI (limited supported tags) | Synthetic single-/two-frame metadata tested and consumed by OHIF 3.11 |
| STOW-RS | multipart/related application/dicom | Synthetic multipart ingest CI passed; partial STOW status semantics |
| OHIF rendering | Loopback development server provides same-origin DICOMweb | OHIF 3.11 rendered a synthetic CR image in Chrome |
| Duplicate and corruption handling | UID collision reject + storage checksum | Unit tests + synthetic UID collision passed; concurrency tests required |
| AE registry | PostgreSQL CRUD (protected HTTP API) | Synthetic HTTP/PostgreSQL integration passed |
| C-FIND/C-MOVE/C-GET SCU | Native addon adapter to allowlisted registered AE | DICOM simulator tests required |
| Study Root C-FIND SCP | Experimental PostgreSQL-backed STUDY/SERIES/IMAGE matching with AE+IP allowlist, loopback-only | JavaScript DIMSE client + DCMTK findscu CI passed; conformance/security tests outstanding |
| Study Root C-MOVE SCP | Experimental, explicitly enabled, UID hierarchy, up to 10 instances, sends with C-STORE SCU to 127.0.0.1 registered AE | DCMTK retrieves two instances; partial rejection produces Warning and the failed SOP UID |
| Study Root C-GET SCP | Experimental, separately enabled, exact hierarchy UIDs (max 10), reverse C-STORE role negotiation, same-association C-STORE acknowledgments | DCMTK getscu retrieved 1 and 2 synthetic CR instances, with corresponding C-GET Completed=1/2 and no failed suboperations; broader tests outstanding |
| DICOM Modality Worklist SCP | Experimental Node.js MWL C-FIND SOP Class 1.2.840.10008.5.1.4.31 on 127.0.0.1:11116, backed by RIS orders | DCMTK findscu -W matches scheduled CT worklist, issuer-scoped search and cancellation exclusion; broader modalities/charset require tests |
| DICOM routing | Automatic per-modality routing rules, persistent jobs, retries, dead-letter, audit, isolated C-STORE SCU worker | DCMTK receiver and rejection/retry network tests |
| Backup/restore, TLS, RBAC, consent | **NOT IMPLEMENTED** | Needed before clinical use |

## P1 routing progress

- Automatic routing only applies to **newly ingested** DICOM instances. Existing studies require manual enqueue.
- Route must be explicitly enabled. Destination AE must exist and be enabled.
- Jobs are unique per SOP Instance UID and destination AE; duplicate ingest does not enqueue a second job.
- Worker uses a DB lease and exponential backoff with dead-letter state, and isolates the C-STORE SCU in a child process and requires Success from the receiver.
- At-least-once behavior: lease expiry or crash after remote acknowledgment can cause a repeat C-STORE; destination MUST handle identical SOP Instance UID consistently.
- No guarantee of clinical-grade delivery, caller AE authentication, encryption, backup/restore, or full DICOM conformance.
- See [routing guide](ROUTING.md).

## C-FIND Query/Retrieve progress

- A separate Node.js DICOM Study Root **C-FIND SCP** now reads the same PostgreSQL `studies`, `series` and `instances` tables as the existing DICOMweb API.
- Supports Study/Series/Image levels with a bounded 100-result limit; parameterized wildcard matches, StudyDate ranges and mandatory hierarchy UIDs at lower levels.
- Explicit startup gate `PACS_FIND_EXPERIMENTAL=1`, loopback-only TCP listener, registered enabled IPv4 AE + remote address check and called AE match; restart required after registry updates.
- C-MOVE is now an **optional** listener capability gated by `PACS_MOVE_EXPERIMENTAL=1`, limited to explicit Study/Series/Image UIDs and 10 instances. Destination AE must be an enabled loopback peer. C-MOVE sends each object on a new C-STORE association and waits for the response before counting it complete.
- Study Root C-GET can be explicitly enabled via `PACS_GET_EXPERIMENTAL=1` alongside the C-FIND listener. Only CR/DX/CT/MR SOP Classes and Implicit/Explicit VR Little Endian are accepted for reverse C-STORE. Missing negotiated requester SCP role is rejected, not silently assumed.
- Independent DCMTK findscu integration succeeded on a synthetic CR study. See [docs/FIND_SCP.md](FIND_SCP.md).

## P1 C-MOVE interoperability

- Independent DCMTK `movescu` requested a synthetic CR study from the Node.js C-MOVE SCP; the separate DCMTK `storescp` received the instance and acknowledged C-STORE Success. C-MOVE finished Success, Completed=1, Failed=0, Remaining=0.
- Unit tests cover bounded hierarchy and invalid identifiers, unknown/disallowed destination, progress counts, and partial transport failure warning status.
- The suite also verifies a two-instance transfer and explicit rejection of one suboperation. Compressed transfer syntax, cancellation, disconnect recovery, TLS, patient authorization, and remote destinations remain open. The current outbound C-MOVE destination is restricted to 127.0.0.1.
- The C-MOVE service must not be enabled for real clinical traffic.
- See [docs/MOVE_SCP.md](MOVE_SCP.md).

## P1 C-GET interoperability

- DCMTK `getscu` requested one and then two synthetic CR instances from Node.js C-GET SCP. The SCP sent all C-STORE-RQ on the **same DIMSE association**, DCMTK acknowledged each C-STORE Success, and C-GET completed with Success, Completed=1/2 respectively, Failed=0.
- The C-STORE SCU role is explicitly negotiated from the requester's storage SOP presentation contexts; unsupported SOP Classes, transfer syntaxes or absent reverse role do not lead to false C-STORE success.
- Unit tests cover missing role/context, missing study UID, success only after store acknowledgment and failure status on unsuccessful sub-operations. The two-instance network test additionally checks SOP Instance UID matching and Pending/Success counters.
- C-GET has not been validated for compressed/multiframe studies, multiple devices, cancellation, TLS or clinical authorization. See [C-GET guide](GET_SCP.md).
- CI evidence: https://github.com/bofandra/pacs/actions/runs/43700540176 (21/21 tests; one- and two-instance DCMTK getscu).

## P1 Modality Worklist / RIS integration

- REST API creates **issuer-qualified** RIS worklist orders with a unique source/external ID, Accession Number plus issuer, Requested Procedure, Scheduled Procedure Step, station AE, local DICOM DA/TM and explicit IANA timezone.
- POST is idempotent for an identical payload. The same source/external order reference with different details is rejected, never silently overwritten.
- Worklist records are separate from stored imaging Study/Series/Instance resources.
- A dedicated experimental Node.js MWL SCP (called AE `PACS_MWL`) supports standard SOP Class `1.2.840.10008.5.1.4.31`, with a one-item `ScheduledProcedureStepSequence` and limited query matching. Results are always scoped to the **calling AE's station**; cancelled, completed, and on-hold orders are excluded.
- DICOM `findscu -W` retrieves scheduled synthetic worklists using Accession Number, Patient ID/issuer, procedure, modality, and local schedule date. The integration test also validates cancellation and paired date/time ranges across midnight.
- Reconciliation checks Study UID, Patient ID and issuer, accession, and any indexed Local Namespace Entity ID from the DICOM accession issuer sequence. A conflicting local issuer produces a mismatch. Old rows or objects without the local issuer cannot verify it. Results are advisory.
- This is a subset, not complete DICOM MWL K.6 conformance. No detailed timezone range semantics across dates, code sequences, HIS authorization scopes, HL7 Order messages, N-SET performed procedure steps, or production transport/security.
- CI evidence: https://github.com/bofandra/pacs/actions/runs/43705016109 (25/25 tests). See [docs/MWL_SCP.md](MWL_SCP.md).

## C-STORE ingress and WADO-RS viewer foundation (15 Nov 2026)

- New experimental JavaScript C-ECHO/C-STORE SCP, enabled explicitly via `PACS_STORE_EXPERIMENTAL=1`, listens on 127.0.0.1 and requires registered calling AE. This is **an alternative** to the older native-addon SCP on the same port, not a replacement of its runtime behavior.
- DCMTK `echoscu` and `storescu` accepted a synthetic CR image. C-STORE Success is sent **after** content-addressed persistence, SHA-256 verification and PostgreSQL indexing. A repeated instance is idempotent; changed payload for the same SOP Instance UID receives a non-success response; unregistered AE is rejected.
- DIMSE C-STORE carries a DICOM dataset, not a Part 10 file. The listener reconstructs a Part 10 file in the negotiated Implicit/Explicit VR Little Endian syntax; **wire-byte identity is not claimed**.
- WADO-RS metadata now exposes selected geometry/pixel attributes and a PixelData `BulkDataURI`. Dedicated endpoints retrieve uncompressed frames (one or multiple) and raw PixelData via multipart/related; 8/16-bit LE only.
- OHIF 3.11 rendered a synthetic CR frame through the loopback development proxy in Chrome. A shared viewer still requires user authentication, study authorization and read audit.
- Verified CI: [C-STORE inbound](https://github.com/bofandra/pacs/actions/runs/43712456701) and [WADO uncompressed frames](https://github.com/bofandra/pacs/actions/runs/43712986915), both 26/26 tests.
- Read [STORE_SCP.md](STORE_SCP.md) and [WADO_OHIF.md](WADO_OHIF.md).

## Verified automated evidence

- GitHub Actions initial core: https://github.com/bofandra/pacs/actions/runs/43686423562 (commit a6a41a81)
- GitHub Actions routing integration: https://github.com/bofandra/pacs/actions/runs/43691572537 (commit 1124c744)
- GitHub Actions C-FIND SCP + DCMTK: https://github.com/bofandra/pacs/actions/runs/43696156648 (commit c5b07b1a, 12/12 tests passed)
- GitHub Actions C-MOVE SCP + DCMTK storescp: https://github.com/bofandra/pacs/actions/runs/43697401682 (commit 38b861ef, 17/17 tests passed)
- GitHub Actions C-GET SCP + DCMTK getscu: https://github.com/bofandra/pacs/actions/runs/43700540176 (commit 0519b7f7, 21/21 tests passed including two-instance retrieval)
- GitHub Actions MWL C-FIND + RIS API + explicit reconciliation: https://github.com/bofandra/pacs/actions/runs/43705016109 (commit 2958e1e2, 25/25 tests passed)
- GitHub Actions C-ECHO/C-STORE inbound: https://github.com/bofandra/pacs/actions/runs/43712456701 (commit fe828b0d, 26/26 tests passed)
- GitHub Actions uncompressed WADO-RS frames and bulkdata: https://github.com/bofandra/pacs/actions/runs/43712986915 (commit 6efdfccd, 26/26 tests passed)
- Node.js syntax check, unit tests, PostgreSQL migration, synthetic Part 10 DICOM parsing, HTTP STOW/QIDO/WADO roundtrip, checksum, duplicate/UID collision rejection and AE registry passed.
- Routing tests cover atomic queueing, retry/backoff, dead-letter and replay. The network scenario verifies C-STORE to DCMTK and retries after a receiver rejection.
- **Not verified:** Legacy native-addon C-STORE inbox from simulator; C-FIND/MOVE/GET SCU native adapter with external peers; MWL with actual modalities or full DICOM K.6; diagnostic display validation; compressed frames. JavaScript C-ECHO/C-STORE ingress is verified only with DCMTK synthetic data. C-FIND, C-MOVE and C-GET SCP are only verified with limited synthetic cases.

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
