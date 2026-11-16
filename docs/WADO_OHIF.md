# WADO-RS frames and OHIF development viewer

**Synthetic data only. NOT FOR CLINICAL USE.**

## WADO-RS scope implemented

- `GET /dicomweb/studies/{study}/metadata`: DICOM JSON metadata built from stored Part 10, including required pixel/geometry tags when present; `7FE00010.BulkDataURI`.
- `GET /dicomweb/studies/{study}/series/{series}/metadata` and instance metadata likewise.
- `GET /dicomweb/studies/{study}/series/{series}/instances/{instance}/frames/{frameList}`: multipart/related `application/octet-stream` raw uncompressed pixel frames.
- `GET /dicomweb/studies/{study}/series/{series}/instances/{instance}/bulkdata/7fe00010`: multipart PixelData retrieval.
- Existing full Part 10 instance retrieval, QIDO-RS, and STOW-RS remain available.

**Supported:** Implicit/Explicit VR Little Endian, uncompressed single-frame and bounded multi-frame 8/16-bit pixel data. Source stored bytes are SHA-256 verified before extraction. No transcoding or JPEG/JPEG2000/JPEG-LS/RLE compressed frames. Bit-packed 1-bit frames are rejected. Frame list capped at 100; invalid frame or UID rejected. This metadata subset is **not** complete DICOM PS3.18 conformance.

## Example

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
 "http://127.0.0.1:3000/dicomweb/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/1" \
 -o first-frame.multipart
```

Use the actual synthetic Study/Series/SOP Instance UIDs in your environment.

## OHIF v3

The loopback development server serves the OHIF build and proxies read-only DICOMweb requests on the same origin. The server supplies the PACS Bearer token to the upstream API.

Start PACS with a synthetic catalog, then download and run the pinned OHIF build.

```bash
mkdir -p data/ohif
npm pack @ohif/app@3.11.0 --pack-destination data/ohif
tar -xf data/ohif/ohif-app-3.11.0.tgz -C data/ohif package/dist
PACS_OHIF_EXPERIMENTAL=1 PACS_OHIF_DIST=./data/ohif/package/dist npm run ohif:dev
```

Open [the local study list](http://127.0.0.1:3400/) or navigate to `/viewer?StudyInstanceUIDs=<synthetic-study-uid>` using the same origin. Optional `PACS_OHIF_PORT` changes the port. The lab binds to `127.0.0.1` and guards the request origin and Host header. Use a separate authenticated reverse proxy with patient/study authorization and audit for any shared deployment. Keep API credentials on the server.

OHIF 3.11.0 and headless Chrome rendered a synthetic 2 × 2 CR image. The browser fetched WADO-RS frame 1 and received the expected eight bytes of uncompressed pixel data. The study list and viewport use the PACS DICOMweb API.

OHIF settings are based on its documented DICOMweb data source fields `qidoRoot`, `wadoRoot`, `imageRendering: 'wadors'` and `thumbnailRendering: 'wadors'`: https://docs.ohif.org/configuration/datasources/dicom-web/

## Known gaps

- The browser check covers one synthetic uncompressed grayscale instance. Diagnostic display validation and other input types require separate testing.
- Metadata is a subset with limited character sets, IOD validation and typed VR handling.
- No compressed frames, transfer syntax negotiation, transcoding, advanced multiframe, segmentation or whole-slide microscopy.
- Missing authenticated reverse proxy, scoped viewer token, viewer audit event logging, access revocation, TLS and CORS hardening.
- Current QIDO-RS supports only basic matching and will need expansion for a fully featured OHIF study list.
- Validate pixel spacing, orientation, window/level, modality LUT, display consistency and diagnostics against independent test fixtures.

Reference: [DICOM PS3.18](https://dicom.nema.org/medical/dicom/current/output/html/part18.html).
