# WADO-RS frames and OHIF integration starting point

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

A proposed same-origin OHIF data source is at `docs/ohif-app-config.js`. Install/deploy OHIF independently and configure an **authenticated reverse proxy** that makes `/dicomweb` accessible on the OHIF origin under a real user session. The proxy must enforce patient/study authorization, issue or inject the service-to-service API token server-side and protect logs. **Do not embed `API_TOKEN` or permanent credentials in browser JavaScript or public files.**

The current HTTP API only has a shared development Bearer token; it is **not** a production user-authenticated image service. The supplied config is not yet an end-to-end working viewer deployment.

OHIF settings are based on its documented DICOMweb data source fields `qidoRoot`, `wadoRoot`, `imageRendering: 'wadors'` and `thumbnailRendering: 'wadors'`: https://docs.ohif.org/configuration/datasources/dicom-web/

## Known gaps

- Browser/Cornerstone integration has not been verified with an actual OHIF runtime.
- Metadata is a subset with limited character sets, IOD validation and typed VR handling.
- No compressed frames, transfer syntax negotiation, transcoding, advanced multiframe, segmentation or whole-slide microscopy.
- Missing authenticated reverse proxy, scoped viewer token, viewer audit event logging, access revocation, TLS and CORS hardening.
- Current QIDO-RS supports only basic matching and will need expansion for a fully featured OHIF study list.
- Validate pixel spacing, orientation, window/level, modality LUT, display consistency and diagnostics against independent test fixtures.

Reference: [DICOM PS3.18](https://dicom.nema.org/medical/dicom/current/output/html/part18.html).
