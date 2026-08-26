# MiniMax Voice Clone Notes

Observed from the authenticated `minimax.io` web runtime on 2026-08-22. These are private web-app contracts and may change without notice.

## Web Flow

- Route: `/audio/voices-cloning`
- Clone endpoint: `POST /v1/api/audio/voice/clone_v2`
- Voice list: `POST /v1/api/audio/voice/list`
- Voice capacity: `GET /v1/api/audio/voice/equity`
- Clone scenes: `GET /v1/api/audio/voice/clone_scene`
- Optional safety check: `POST /v1/api/audio/voice/clone_cn_check`
- Upload uses MiniMax OSS policy and multipart upload with `fileScene: 11` (`VOICE_CLONE`).
- A successful clone appears in My Voices with `generate_channel: 1` and is usable by its immutable `voice_id` in Direct TTS.

## Upload Validation

- Maximum files: 10.
- Maximum file size: 50 MB per file.
- Per-file uploaded duration: 1-300 seconds.
- Total uploaded duration: 10-300 seconds.
- Browser recording duration: 10-60 seconds.
- Accepted extensions: `wav`, `mp3`, `mpeg`, `mp4`, `m4a`, `avi`, `mov`, `wmv`, `flv`, `mkv`, `webm`.
- Recommended input: one speaker, clean speech, quiet environment, no reverb or background noise.
- Noise isolation is optional and may remove voice detail.
- The user must explicitly confirm they have the rights and consent to clone the voice.

Validation must happen locally before upload. Server validation and safety review remain authoritative.

## Durable Automation Model

Each requested clone should have a durable record containing:

```text
localCloneId
sourceFileName
sourceHash
duration
size
voiceName
language
uploadFileId
uploadOssPath
cloneRequestStartedAt
voiceId
voiceStatus
failureReason
```

Safe sequence:

1. Validate count, extension, size, duration, and total duration locally.
2. Hash each source to prevent duplicate uploads and clones.
3. Obtain upload policy for `fileScene: 11`.
4. Upload to OSS and persist `fileId` before clone creation.
5. Call `clone_v2` once under a durable reservation.
6. On an uncertain response, query My Voices before any retry.
7. Persist returned/discovered `voiceId` and wait for approved `voiceStatus`.
8. Bind TTS entries by `voiceId`, never only by display name.

## Current `mp` Voice Set

The authenticated account had 32 approved `mp` Instant Clones and used 243 of 250 voice slots.

Primary voices:

| Script identity | Dictor | Doctor |
| --- | --- | --- |
| `VSLD-4763` | `mp dic VSLD-4763` | `mp doc VSLD-4763` |
| `VSLD-4765` | `mp dic VSLD-4765` | `mp doc VSLD-4765` |
| `VSLD-4767` | `mp dic VSLD-4767` | `mp doc VSLD-4767` |
| `VSLL-2163` | `mp dic VSLL-2163` | `mp doc VSLL-2163` |
| `VSLL-2165` | `mp dic VSLL-2165` | `mp doc VSLL-2165` |

Fixture-specific test alias, not a production rule:

```text
VSLL-2164 -> VSLL-2163
```

This alias was supplied explicitly for the `translated_backup` stress-test fixture. Production auto-mapping does not rewrite project IDs.

Testimonial voices:

- RU, SV, and TR: women 1-4 and men 1-2.
- FR: women 1-2 and men 1-2.
- Naming pattern: `mp отзыв <женщина|мужчина> <number> <language code>`.

## Shared History Risk

MiniMax History is account-wide. Other users can add records while automation is running. Text, display voice name, and timestamps are not sufficient unique identifiers. Clone and TTS automation must prefer immutable IDs and treat ambiguous History matches as unresolved rather than guessing.
