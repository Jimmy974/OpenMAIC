# Classroom generation API (for bots)

How an external agent (for example a Grok bot) creates a classroom on this
OpenMAIC deployment, with attachments, the same way the web page does.

The generation runs on the server: the bot submits a job, polls it, and gets
a classroom link. No browser tab is needed.

## Access

- Base URL: `https://<host>.ts.net` (through Tailscale; the bot's machine must
  be on the tailnet) or `http://127.0.0.1:3000` on the server itself.
- Every request carries the service token:
  `Authorization: Bearer <AUTH_SERVICE_TOKEN>`.
- Do not send `Origin` or `Sec-Fetch-Site: cross-site` headers (browser-only
  headers; cross-site requests are refused).

Errors: `401 AUTH_REQUIRED` = missing or wrong token; `400` = invalid request
(the body says which field); `404` = not allowed or not found; `413` = files
too large.

## 1. Submit a job

`POST /api/generate-classroom`

Two ways to send it. Both take the same fields.

### a) multipart/form-data (recommended when you have files)

| Part | Type | Notes |
|---|---|---|
| `request` | text (JSON) | The fields in the table below |
| `files` | file, repeatable | Up to 5 files |

```bash
curl -sS -X POST "$BASE/api/generate-classroom" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'request={"requirement":"Teach the attached worksheet to a UK Year 8 (KS3) student ...","model":"grok-4.7-medium","shareWith":["student@example.com"],"enableTTS":true,"enableImageGeneration":true}' \
  -F "files=@worksheet.pdf" \
  -F "files=@page2.jpg"
```

### b) JSON (files as base64)

```json
{
  "requirement": "Teach the attached worksheet ...",
  "attachments": [
    { "name": "worksheet.pdf", "mimeType": "application/pdf", "data": "<base64>" }
  ]
}
```

### Fields

| Field | Required | Meaning |
|---|---|---|
| `requirement` | yes | What to teach and how. See the templates below. |
| `studentProfile` | no | One or two sentences about the learner, like the web page's "Hi, Learner", e.g. `"UK Year 8 student (KS3). Likes step-by-step explanations."` |
| `model` | no | One of the server's models, e.g. `"grok-4.7-low"` (fast), `"grok-4.7-medium"` (maths / answer keys), `"grok-4.7-high"`. Defaults to the server default (low). Interactive pages always use the server's route (medium). |
| `owner` | no | Login of the member who owns the new course (it appears in their library). Defaults to the service owner (the parent). Must be a member who has opened the site once. |
| `shareWith` | no | Logins of members who should see the course under "Shared with me". Each must have opened the site once. |
| `enableTTS` | no | `true` = record the teacher's voice for every line. Recommended. |
| `enableImageGeneration` | no | `true` = generate pictures for slides. |
| `agentMode` | no | `"generate"` = tailor the AI teacher and classmates to the topic; default uses the built-in ones. |
| `enableWebSearch` | no | Needs a web-search provider on the server (none configured today). |

### Attachments

Up to **5 files**, **50 MB each**, 150 MB in total. Accepted:

| Type | What the AI gets |
|---|---|
| PDF (`.pdf`) | The text, and the page pictures (photographed or scanned worksheets work) |
| Images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`) | The picture itself |
| PowerPoint (`.pptx`) | Each slide's text, and the pictures on the slides |
| Word (`.docx`) | The text, and the pictures in it |
| Text (`.txt`, `.md`) | The text |

Old binary `.ppt` / `.doc` are not supported: save them as `.pptx` / `.docx`.
The AI reads up to about 50,000 characters of text and looks at up to 20
pictures in total; split a whole book into chapters (one classroom each).

### Response (202)

```json
{
  "success": true,
  "jobId": "abc123",
  "status": "queued",
  "pollUrl": "https://<host>/api/generate-classroom/abc123",
  "pollIntervalMs": 5000,
  "attachments": { "files": 2, "textChars": 1830, "images": 3 }
}
```

`attachments` reports what was read from the files, so the bot can tell at
once if a file produced nothing.

## 2. Poll the job

`GET /api/generate-classroom/{jobId}` with the same `Authorization` header,
about every 30–60 seconds, until `status` is `succeeded` or `failed`. Never
resubmit because one poll failed.

```json
{
  "success": true,
  "status": "running",
  "step": "generating_scenes",
  "progress": 45,
  "message": "Generating scene 5/12: Two Signs Side by Side",
  "scenesGenerated": 4,
  "totalScenes": 12,
  "done": false
}
```

On success:

```json
{
  "status": "succeeded",
  "done": true,
  "result": {
    "classroomId": "Xy12AbCd9Q",
    "url": "https://<host>/classroom/Xy12AbCd9Q",
    "scenesCount": 12
  }
}
```

Send the `url` to the student. It is in the owner's library, in every
`shareWith` member's "Shared with me", and the parent's Family page shows the
students' quiz results for it.

Typical time: about 1 minute per page on `grok-4.7-low`, 2–3 minutes on
`grok-4.7-medium`, plus voice recording when `enableTTS` is on.

## Requirement templates

GCSE (replace the subject and tier):

```
Teach the attached material to a UK Year 11 student sitting GCSE [Maths Higher] this summer.
1. First work out what topic and skills the material covers.
2. Explain each idea step by step in simple words, one idea per slide, using worked examples taken from the material.
3. After each part, add a short quiz of 4-5 GCSE exam-style questions of the SAME type as the material but with different numbers or examples. Show the marks for each question, mix multiple choice and short answers, and give mark-scheme style working in every explanation, including common mistakes.
4. Finish with a 10-question mixed exam-style quiz from easy to hard.
```

Year 8:

```
Teach the attached material to a UK Year 8 (KS3) student.
1. First work out what topic and skills the material covers.
2. Explain each idea step by step in simple words, one idea per slide, using worked examples taken from the material.
3. After each part, add a short quiz of 4-5 questions of the SAME type as the material but with different numbers or examples. Mix multiple choice and short answers, and show the working in every explanation.
4. Finish with a 10-question mixed quiz from easy to hard.
```

## Rules for the bot

1. One job at a time per request from a person; do not submit a second job
   while one is `queued` or `running`.
2. The lesson's language follows the `requirement`: write it in English for an
   English lesson (there is no `language` field).
3. Use `grok-4.7-medium` for maths and anything with answer keys.
4. If `attachments.textChars` is 0 and `attachments.images` is 0, the files
   were unreadable: tell the person instead of generating an empty lesson.
5. Report the `url` only after `status` is `succeeded`.
