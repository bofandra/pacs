# Native Modality Worklist (MWL) SCP — Prototype

**Synthetic data only — NOT FOR CLINICAL USE.** This is a standalone Node.js Modality Worklist Information Model C-FIND SCP backed by PostgreSQL scheduling records, not an Orthanc/dcm4chee PACS wrapper.

## Design

```text
RIS/SIMRS -> HTTP Bearer POST /api/v1/ris/worklist-orders
             |  sourceSystem/externalOrderId idempotency
             |  PatientID + IssuerOfPatientID
             |  AccessionNumber + accessionIssuer
             v
        ris_worklist_orders (PostgreSQL)
             |
             v
 DICOM modality (MWL SCU) -- C-FIND 1.2.840.10008.5.1.4.31 -->
     Node.js MWL SCP (127.0.0.1:11116; AET PACS_MWL)
             |
             v
 ScheduledProcedureStepSequence + Patient/Order metadata

 Modality acquisition -> C-STORE / STOW -> PACS archive
             |
             v
 GET /api/v1/ris/worklist-orders/{id}/reconciliation
 (read-only identity comparison; never automatically merge patient records)
```

Supported MWL response includes PatientName, PatientID, IssuerOfPatientID, PatientBirthDate, PatientSex, AccessionNumber, IssuerOfAccessionNumberSequence, StudyInstanceUID, RequestedProcedureID/Description, SpecificCharacterSet, and a **one-item ScheduledProcedureStepSequence** with station AET, modality, local date/time, SPS ID and description.

When a client supplies both date and time ranges, the SCP matches a continuous interval across days in the scheduled station's local time. Separate date-only and time-only queries use their own filters.

### Enable

Requires Node.js 22+, PostgreSQL, and a configured HTTP `API_TOKEN`.

```bash
cp .env.example .env
docker compose up -d postgres
npm install
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js
```

Register the simulator's *calling* AE in the HTTP AE registry. Example:

```bash
curl -X PUT http://127.0.0.1:3000/api/v1/aes/SIMULATOR \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"host":"127.0.0.1","port":11114,"enabled":true}'
```

In another shell (the allowlist is loaded at startup):

```bash
PACS_MWL_EXPERIMENTAL=1 node --env-file=.env src/mwl-scp.js
```

It binds **127.0.0.1:11116** and called AE `PACS_MWL`. It only accepts an enabled, registered **loopback calling AE**. It does not provide TLS or production authorization.

### Create an order via RIS API

```bash
curl -X POST http://127.0.0.1:3000/api/v1/ris/worklist-orders \
 -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
 -d '{
  "sourceSystem":"RIS_SIM","externalOrderId":"ORDER-0001",
  "accessionIssuer":"RS_TEST","accessionNumber":"ACC202611150001",
  "patientId":"TEST001","issuerOfPatientId":"RS_TEST",
  "patientName":"TEST^PATIENT","patientBirthDate":"19800101","patientSex":"F",
  "studyInstanceUID":"2.25.123456789","requestedProcedureId":"RP-0001",
  "requestedProcedureDescription":"CT Head",
  "scheduledProcedureStepId":"SPS-0001",
  "scheduledProcedureStepDescription":"CT Head Without Contrast",
  "scheduledStationAETitle":"SIMULATOR","modality":"CT",
  "scheduledStartDate":"20261116","scheduledStartTime":"103000",
  "scheduleTimezone":"Asia/Jakarta"
 }'
```

All identifying fields are mandatory for the prototype, including issuer namespaces. The local schedule is preserved as DICOM DA (`YYYYMMDD`) and TM (`HHMMSS`), not converted into UTC. Identical resubmission is idempotent; conflicting data for the same source/order reference returns HTTP 409. Schedule amendments and richer order lifecycle actions are not yet available.

### Query with DCMTK

```bash
findscu -W -v \
  -aet SIMULATOR -aec PACS_MWL \
  -k '(0040,0100)[0].ScheduledStationAETitle=SIMULATOR' \
  -k '(0040,0100)[0].Modality=CT' \
  -k '(0040,0100)[0].ScheduledProcedureStepStartDate=20261116' \
  -k 'PatientID=TEST001' -k 'IssuerOfPatientID=RS_TEST' \
  -k AccessionNumber \
  127.0.0.1 11116
```

Unlike Study Root C-FIND, the MWL request contains a **single ScheduledProcedureStepSequence item**. Only matched scheduled orders for the **calling** station AE are returned. Requests selecting another station AE are rejected. Supported matching keys are intentionally limited to common worklist identity, procedure, modality, and schedule attributes. Matching wildcard and date/time ranges are supported as a subset.

### Cancel an order

```bash
curl -X PATCH http://127.0.0.1:3000/api/v1/ris/worklist-orders/1/status \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"cancelled"}'
```

Supported states: `scheduled`, `on_hold`, `completed`, `cancelled` with a restricted transition graph. Only `scheduled` records are discoverable via MWL.

### Check acquired DICOM against its order

After a test CT file has arrived through PACS STOW/C-STORE, run:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  http://127.0.0.1:3000/api/v1/ris/worklist-orders/1/reconciliation
```

Statuses include `not_received`, `mismatch`, `insufficient_evidence`, and `identity_consistent`. The result is advisory. DICOM `IssuerOfPatientID (0010,0021)` provides patient-ID issuer evidence. For newly indexed objects, the Local Namespace Entity ID in `IssuerOfAccessionNumberSequence (0008,0051)` can establish accession issuer evidence. A conflicting local issuer produces a mismatch. Missing sequences, universal-ID-only sequences, and older index rows without this metadata leave `accessionIssuerVerified` false.

### Verified and missing

- [x] PostgreSQL scheduling schema and REST lifecycle API.
- [x] Independent DCMTK `findscu -W` query, including modality/station/issuer scoping.
- [x] Cancelled orders excluded; duplicate order is idempotent; changed identity rejected.
- [x] Synthetic RIS order → worklist → DICOM ingest → advisory reconciliation; issuer mismatch is explicitly flagged.
- [x] DCMTK queries a date/time interval across midnight. Synthetic objects cover matching, conflicting, and missing accession issuer evidence.
- [ ] Interoperability with real CT/MR/CR/DR console vendors.
- [ ] Full DICOM PS3.4 K.6 key set, code sequences and complete date/time matching semantics.
- [ ] Production authorization/TLS, multi-site station access scopes, HL7 ORM/RIS connector, order amendments, audit review, downtime continuity.
- [ ] Complete issuer of accession number verification, reconciliation workflow approvals, MPPS and structured report integration.

CI: https://github.com/bofandra/pacs/actions/runs/43705016109 (25/25 passed).

References: [DICOM PS3.4 K.6](https://dicom.nema.org/medical/dicom/current/output/html/part04.html#sect_K.6), [DCMTK findscu](https://support.dcmtk.org/docs/findscu.html), [DICOM PS3.2](https://dicom.nema.org/medical/dicom/current/output/html/part02.html).
