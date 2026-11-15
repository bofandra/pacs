# Experimental PostgreSQL-backed Study Root C-FIND SCP

**Not for clinical use.** This standalone Node.js listener implements DICOM Study Root **C-FIND** only (STUDY, SERIES, IMAGE), using the same PostgreSQL PACS catalog as STOW-RS/QIDO-RS. It does not outsource indexing to an external PACS or use Orthanc/dcm4chee.

## Architecture

```text
DCMTK findscu / DICOM Query SCU
        |
        | DICOM association + C-FIND RQ (Study Root)
        v
Node.js dcmjs-dimse Scp (127.0.0.1:11115 only)
        |   association AE / IPv4 peer allowlist
        v
findStudyRoot() -> parameterized SQL -> PostgreSQL
        |
        v
Pending C-FIND responses -> final Success or ProcessingFailure
```

**Supported syntaxes:** Explicit and Implicit VR Little Endian for the query command/dataset (no transcoding). Supported query levels: STUDY, SERIES, IMAGE. For SERIES, StudyInstanceUID must be specified; for IMAGE, StudyInstanceUID and SeriesInstanceUID are mandatory. Patient ID/name, AccessionNumber, StudyDate range and basic UIDs can be searched as applicable. Wildcards '*' and '?' are supported for text matching. The result cap is 100; oversized result sets are rejected, not silently truncated. All SQL uses bound parameters.

## Start (synthetic data only)

```bash
cp .env.example .env
# Set API_TOKEN and DATABASE_URL; change the example credentials.
npm install
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js
```

Register an authorized **IPv4 literal** calling peer; in this example the simulator uses the same host:

```bash
curl -X PUT http://127.0.0.1:3000/api/v1/aes/SIMULATOR \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"host":"127.0.0.1","port":11114,"enabled":true}'
```

Start after registering peers (allowlist snapshot is taken at startup):

```bash
PACS_FIND_EXPERIMENTAL=1 node --env-file=.env src/find-scp.js
```

The C-FIND listener is **127.0.0.1:11115**, not `0.0.0.0`; the separate native C-STORE SCP retains its own port `11112`. The C-FIND listener accepts only known calling AE titles from enabled `ae_nodes` rows whose registered IPv4 address equals the TCP remote address, and only when the called AE matches `PACS_AET`. It rejects unsupported presentation contexts.

## Independently verify with DCMTK

After uploading a **synthetic** study into PACS (via STOW-RS), run:

```bash
findscu -S -v +sr -aet SIMULATOR -aec PACS_NATIVE \
  -k QueryRetrieveLevel=STUDY \
  -k PatientID=SYNTHETIC-001 \
  -k StudyInstanceUID \
  127.0.0.1 11115
```

Replace `PatientID` only with an explicitly synthetic test identifier. To test a specific study, pass `-k StudyInstanceUID=2.25....`.

GitHub Actions runs the same flow with an independent `findscu` executable in addition to a JavaScript DIMSE client. Passing these tests is **not** a DICOM PS3.2 Conformance Statement.

## Limitations and safety

- **C-MOVE and C-GET SCP are not implemented**; their presentation contexts are rejected. They require verified C-STORE suboperations, SOP Class/Transfer Syntax negotiation, counters, and error status handling.
- Worklist C-FIND (MWL), Patient Root, Patient/Study-only Root, relational queries and advanced matching are not implemented.
- No Patient ID issuer scoping, RBAC, TLS or comprehensive query access audit. Never expose on a clinical or public interface.
- C-FIND peer registry is loaded at startup; restart this listener after an AE registry change. The listener only binds to loopback and does not allow remote hosts.
- No generic DICOM arbitrary identifier dataset passthrough; supported match keys are deliberately restricted.
- The study/series/image matching tests exercise a small synthetic fixture only; mixed modality and multibyte character sets need broader validation.

Standard references: [DICOM PS3.4](https://dicom.nema.org/medical/dicom/current/output/html/part04.html) and [DICOM PS3.2](https://dicom.nema.org/medical/dicom/current/output/html/part02.html).
