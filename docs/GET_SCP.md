# Experimental Study Root C-GET SCP

**Research/development only. NOT FOR CLINICAL USE.** No real patient data.

C-GET is implemented in Node.js using `dcmjs-dimse` with PostgreSQL-backed instance selection and SHA-256-verified DICOM object storage. Unlike C-MOVE, **C-STORE suboperations are sent on the same association as the C-GET request**.

## Procedure

```text
DCMTK getscu -- [Study Root C-GET RQ + proposed Storage SCP roles] -->
PACS Query SCP (127.0.0.1:11115)
  -> Validate calling AE / called AE / IPv4 peer + C-GET SOP context
  -> Accept only proposed reverse-role C-STORE contexts for CR, DX, CT or MR
  -> Select up to 10 DICOM instances (exact Study/Series/Image UIDs)
  -> Check original object SHA-256
  -> C-STORE RQ (same connection) --> getscu responds C-STORE Success
  -> C-GET final Success / Warning + suboperation counters
```

## Start

Set up PostgreSQL and PACS API as in the [README](../README.md), then register a loopback peer in the AE registry:

```bash
curl -X PUT http://127.0.0.1:3000/api/v1/aes/SIMULATOR \
 -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
 -d '{"host":"127.0.0.1","port":11114,"enabled":true}'
```

Start the query listener with C-GET enabled. This process always binds to 127.0.0.1 and reads the registered AE allowlist at startup:

```bash
PACS_FIND_EXPERIMENTAL=1 PACS_GET_EXPERIMENTAL=1 \
 node --env-file=.env src/find-scp.js
```

After ingesting a **synthetic** CR/DX/CT/MR DICOM Part 10 object via STOW-RS:

```bash
mkdir -p ./test-received-get
getscu -S -v -aet SIMULATOR -aec PACS_NATIVE \
 -od ./test-received-get \
 -k QueryRetrieveLevel=STUDY \
 -k StudyInstanceUID=2.25.123456789 \
 127.0.0.1 11115
```

Use the StudyInstanceUID of an actual synthetic fixture, not the example UID above.

## What has been verified

- GitHub Actions: https://github.com/bofandra/pacs/actions/runs/43700540176
- Independent DCMTK `getscu` associated with the Node.js C-GET SCP and negotiated storage roles for the original connection. A second invocation retrieved **two SOP instances** with separate C-STORE acknowledgments and one C-GET Pending + final Success response.
- The Node.js SCP selected one synthetic CR instance and sent a C-STORE-RQ on **that same association**.
- DCMTK returned C-STORE Success; the PACS sent C-GET final Success (Remaining=0, Completed=1, Failed=0) and the saved instance's SOP UID matched the source.
- Unit tests cover missing role, unsupported SOP Class, mismatched Transfer Syntax, malformed selection, and a failed C-STORE acknowledgement.

## Restrictions / outstanding work

- Supports only selected CR/DX/CT/MR SOP Classes and **Implicit/Explicit VR Little Endian**. Compressed Transfer Syntaxes are not advertised or transcoded.
- Query must use Study/Series/Image level with explicit UIDs. Max 10 instances per C-GET request.
- No C-CANCEL support or production-level async operation negotiation. The two-instance test passed, but large studies, differing modalities, and interrupted transfers need separate validation.
- No patient-level RBAC, cross-facility consent, issuer scoping, audit of all read operations, TLS or production-safe storage life-cycle.
- Keep the listener on loopback; there is no authenticated transport for actual hospital subnet use.
- Current implementation is a prototype and not a PS3.2 Conformance Statement.

Standard: [DICOM PS3.4](https://dicom.nema.org/medical/dicom/current/output/html/part04.html) and [DICOM PS3.8](https://dicom.nema.org/medical/dicom/current/output/html/part08.html).
