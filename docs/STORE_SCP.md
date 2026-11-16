# Inbound C-ECHO / C-STORE SCP (experimental)

**Node.js development listener only; NOT FOR CLINICAL USE.**

## Two alternative listeners

- `src/store-scp.js` uses `dcmjs-dimse`, persists a reconstructed DICOM Part 10 object and PostgreSQL metadata *before* acknowledging C-STORE. This pathway has been tested with independent DCMTK.
- `src/dimse-scp.js` uses the optional `dicom-dimse-native` add-on to save files into an inbox that is indexed asynchronously by `inbox-worker.js`. It remains **unverified** and does not provide the same acknowledgment guarantee.

**Never run both listeners on the same port.** Both default to port `11112`.

## Quick start

Requires PostgreSQL, Node.js 22+, a long API_TOKEN and at least one enabled loopback AE in the registry.

```bash
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js

curl -X PUT http://127.0.0.1:3000/api/v1/aes/SIMULATOR \
 -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
 -d '{"host":"127.0.0.1","port":11114,"enabled":true}'

PACS_STORE_EXPERIMENTAL=1 node --env-file=.env src/store-scp.js
```

The AE allowlist is loaded at startup. Listener binds **127.0.0.1** only.

```bash
echoscu -v -aet SIMULATOR -aec PACS_NATIVE 127.0.0.1 11112
storescu -v -aet SIMULATOR -aec PACS_NATIVE 127.0.0.1 11112 synthetic-cr.dcm
```

Use **synthetic** CR/DX/CT/MR files only, with Explicit or Implicit VR Little Endian. After receiving C-STORE Success, the study is immediately queryable through QIDO-RS, and WADO-RS can retrieve its stored Part 10 representation.

## Acknowledgment and originality

DIMSE C-STORE transmits a *dataset*, not the original DICOM Part 10 wrapper. This listener reconstructs a valid Part 10 file using the negotiated Transfer Syntax, checks command/dataset SOP Class and Instance UID identity, writes to the content-addressed object store, commits the indexed record and only then returns Success. This does **not** mean bit-for-bit preservation of the original sender's Part 10 header.

Duplicate SOP Instance UID + identical canonical bytes is idempotent; a conflicting UID/content rejects the request. For now compression, large workloads, TLS, issuer scoping, traffic from remote devices and operational recovery remain unsupported/unverified.

Verified in CI: https://github.com/bofandra/pacs/actions/runs/43712456701. This is not a DICOM PS3.2 conformance claim.
