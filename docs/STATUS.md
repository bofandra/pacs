# Implementation status and DICOM conformance gaps

**Prototype only — NOT FOR CLINICAL USE.** Checklist assertions supplied in a chat are not test evidence.

| Capability | Implementation in this branch | Verification |
| --- | --- | --- |
| C-ECHO SCP | Native addon startStoreScp listener configured | Integration test required |
| C-STORE SCP | Native addon writes incoming instances to inbox | Integration test required |
| Metadata indexing | PostgreSQL schema + inbox ingestion | Needs real DICOM fixtures |
| Immutable storage + SHA-256 | Content-addressed filesystem files | Unit tests supplied |
| QIDO-RS studies/series/instances | Query endpoints | Protocol conformance tests required |
| WADO-RS instance retrieval | multipart/related full DICOM instance | Test with DICOMweb client required |
| WADO-RS metadata | Selected attributes (subset) | Not yet viewer-conformant |
| STOW-RS | multipart/related application/dicom | Partial STOW status semantics |
| OHIF rendering | **NOT IMPLEMENTED / NOT VERIFIED** | Requires complete metadata/frames and viewer config |
| Duplicate and corruption handling | UID collision reject + storage checksum | Concurrency tests required |
| AE registry | PostgreSQL CRUD (protected HTTP API) | Integration test required |
| C-FIND/C-MOVE/C-GET SCU | Native addon adapter to allowlisted registered AE | DICOM simulator tests required |
| C-FIND/C-MOVE/C-GET SCP | **NOT IMPLEMENTED** | Design + native adapter required |
| DICOM Modality Worklist SCP | **NOT IMPLEMENTED** | Native MWL support not available in selected addon |
| DICOM routing | **NOT IMPLEMENTED** | Job queue, policy, audit required |
| Backup/restore, TLS, RBAC, consent | **NOT IMPLEMENTED** | Needed before clinical use |

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
