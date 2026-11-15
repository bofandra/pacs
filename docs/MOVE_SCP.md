# Experimental Study Root C-MOVE SCP

**Development / synthetic data only. NOT FOR CLINICAL USE.**

This is an original Node.js C-MOVE SCP for the PACS PostgreSQL catalog. It does not rely on an Orthanc or dcm4chee PACS.

## Flow

```text
DCMTK movescu: C-MOVE RQ {StudyInstanceUID, MoveDestination}
  -> dcmjs-dimse SCP (127.0.0.1:11115)
  -> AE allowlist + called AET check
  -> QueryInstance metadata by exact study/series/instance UID (max 10)
  -> Read content-addressed Part 10 DICOM and verify SHA-256
  -> Separate C-STORE association to enabled, registered destination AE (127.0.0.1)
  -> C-STORE Success acknowledgment -> completed counter
  -> C-MOVE final Success (or Warning/Failure)
```

The service uses no patient data in source-control test fixtures.

## Start

1. Start the PostgreSQL and PACS HTTP API as documented in [README](../README.md).
2. In the HTTP AE registry, register **both** the DICOM requester (`SIMULATOR`, host `127.0.0.1`) and destination (`DEST_SCP`, host `127.0.0.1`, port `11114`), enabled.
3. Import one synthetic DICOM Part 10 file via STOW-RS, then start the Query SCP with explicit opt-in.

```bash
PACS_FIND_EXPERIMENTAL=1 PACS_MOVE_EXPERIMENTAL=1 \
 node --env-file=.env src/find-scp.js
```

**Important**: the AE registry is snapshot-loaded when this SCP starts. Restart after adding or changing AEs. The listener is loopback only; the C-MOVE destination must also be loopback. Port `11115` is separate from the native C-STORE ingress port `11112`.

Start DCMTK on the same development host:

```bash
mkdir -p ./test-received
storescp -aet DEST_SCP -od ./test-received 11114
```

Request the exact synthetic study (replace with its actual StudyInstanceUID):

```bash
movescu -S -v \
 -aet SIMULATOR -aec PACS_NATIVE -aem DEST_SCP \
 -k QueryRetrieveLevel=STUDY \
 -k StudyInstanceUID=2.25.123456789 \
 127.0.0.1 11115
```

For a SERIES query add `SeriesInstanceUID`; for IMAGE also add `SOPInstanceUID`. Wildcard and broad retrieval are intentionally refused. Only 10 instances may be selected per request.

## Verified automated evidence

- CI run: https://github.com/bofandra/pacs/actions/runs/43697401682
- PostgreSQL indexed a synthetic uncompressed CR image.
- Independent DCMTK `movescu` opened a DIMSE association and requested C-MOVE to `DEST_SCP`.
- Native Node.js Query SCP selected one instance, sent it through `dcmjs-dimse` C-STORE SCU and received DCMTK `storescp` C-STORE Success.
- Final C-MOVE response was Success, Remaining=0, Completed=1, Failed=0, Warnings=0. The saved instance was parsed and its SOP Instance UID matched.
- Unit tests cover invalid identifiers, unknown destination, bounded result cap, pending counters, and partial transport failure warning.

**This is not DICOM PS3.2 Conformance certification.**

## Explicit limitations

- Only study/series/image exact UIDs; 10 instances at most; Transfer Syntax must be Explicit or Implicit VR Little Endian. Unsupported compressed syntaxes fail suboperations.
- **Only IPv4 127.0.0.1 destination**, AE must be enabled and registered before listener startup. No remote hospital network transfer.
- No C-CANCEL handling, cross-facility access control, transport TLS, throttling, association authorization beyond registered AE/IP, or patient consent policy.
- One C-STORE association per instance; not efficient for high-volume imaging.
- Unit tests cover partial errors; only one-instance DCMTK end-to-end success is tested. Multi-instance and network-interruption semantics must be independently verified.
- Warning response may include Failed SOP Instance UID List; conformance and status handling need validation across devices.
- C-GET SCP is implemented as a separate experimental feature. It uses same-association C-STORE with SCU/SCP Role Selection; see [GET_SCP.md](GET_SCP.md).

Standards: [DICOM PS3.4](https://dicom.nema.org/medical/dicom/current/output/html/part04.html), [DICOM PS3.2](https://dicom.nema.org/medical/dicom/current/output/html/part02.html).
