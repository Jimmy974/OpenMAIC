# OpenMAIC classroom API — guide for bots

_Last updated: 2026-09-27 (concise lessons, cancellation, base URL)._

Use this when a person asks you to turn material (a PDF, photos of a
worksheet, slides, notes) or a topic into an OpenMAIC classroom: a lesson
with narrated slides and quizzes. The server does all the generation. You
submit a job, poll it, and send the person the classroom link.

## Connection

| | |
|---|---|
| Base URL | `https://<your-host>.<tailnet>.ts.net` (Tailscale only: your machine must be on the tailnet). On the server itself: `http://127.0.0.1:3000`. |
| Auth | Header `Authorization: Bearer $OPENMAIC_TOKEN` on every request. The operator gives you the token (stored on the server in `~/source/identity-bridge/service-token.txt`). Never print or log it. |

Always call the Tailscale base URL (`https://<your-host>.<tailnet>.ts.net`), even from the server
itself: the classroom link in the result is built from the address you call,
so a job submitted to `http://127.0.0.1:3000` returns a link the person
cannot open.

Do not send `Origin` or `Sec-Fetch-Site` headers.

## Step 1 — submit a job

`POST {BASE}/api/generate-classroom`

### With files (multipart, preferred)

One `request` part (a JSON object with the fields below) and one `files` part
per file:

```bash
curl -sS -X POST "$BASE/api/generate-classroom" \
  -H "Authorization: Bearer $OPENMAIC_TOKEN" \
  -F 'request={"requirement":"Teach the attached material to a UK Year 8 (KS3) student. ...","model":"grok-4.7-medium","enableTTS":true}' \
  -F "files=@worksheet.pdf;type=application/pdf" \
  -F "files=@page2.jpg;type=image/jpeg"
```

### Without multipart (JSON, files as base64)

```bash
curl -sS -X POST "$BASE/api/generate-classroom" \
  -H "Authorization: Bearer $OPENMAIC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requirement":"...","model":"grok-4.7-low","enableTTS":true,
       "attachments":[{"name":"notes.pdf","mimeType":"application/pdf","data":"<base64>"}]}'
```

A topic without files works too: send only the fields.

### Fields

| Field | Required | Use |
|---|---|---|
| `requirement` | yes | What to teach and how. Use a template below. **The lesson's language follows this text**: write it in English for an English lesson. |
| `model` | no | `grok-4.7-low` (fastest, general subjects), `grok-4.7-medium` (maths and anything with answer keys), `grok-4.7-high` (slowest). Default: low. |
| `studentProfile` | no | One or two sentences about the learner, e.g. `"UK Year 11 student sitting GCSE this year."` |
| `enableTTS` | no | `true` = the teacher's voice for every line. Recommended. |
| `enableImageGeneration` | no | `true` = generated pictures on slides. |
| `agentMode` | no | `"generate"` = a teacher and classmates tailored to the topic. |
| `shareWith` | no | Logins (emails) of family members to share the lesson with. Only when the person asks. Each must have opened the site once. |
| `owner` | no | Login whose library the lesson goes into. Default: the parent. Leave it out unless asked. |

### Files

Up to **5 files**, **50 MB each**, 150 MB total.

| Type | What the lesson uses |
|---|---|
| `.pdf` | Text and page pictures (photographed or scanned pages work) |
| `.png` `.jpg` `.jpeg` `.webp` `.gif` | The picture |
| `.pptx` | Each slide's text and pictures |
| `.docx` | Text and pictures |
| `.txt` `.md` | Text |

Old `.ppt` / `.doc` are refused: ask for `.pptx` / `.docx`. The lesson reads
about 50,000 characters and looks at up to 20 pictures; for a whole book,
make one classroom per chapter.

### Response — `202`

```json
{
  "success": true,
  "jobId": "abc123",
  "status": "queued",
  "pollUrl": "https://<your-host>.<tailnet>.ts.net/api/generate-classroom/abc123",
  "pollIntervalMs": 5000,
  "attachments": { "files": 1, "textChars": 1830, "images": 2 }
}
```

If you sent files and `attachments.textChars` and `attachments.images` are
both `0`, nothing could be read: tell the person instead of waiting for an
empty lesson.

## Step 2 — poll until done

`GET {pollUrl}` with the same `Authorization` header, every 30–60 seconds.

```json
{ "status": "running", "step": "generating_scenes", "progress": 45,
  "message": "Generating scene 5/12: Two Signs Side by Side",
  "scenesGenerated": 4, "totalScenes": 12, "done": false }
```

- `status` goes `queued` → `running` → `succeeded` or `failed`.
- Keep polling while `queued` or `running`. A failed poll request is not a
  failed job: try again at the next interval; never submit the job again.
- Typical time: about 1 minute per page on low, 2–3 minutes on medium, plus
  voice recording. A concise 6-page lesson on medium takes about 15–20
  minutes; a 12-page one about 35–45. You may
  tell the person roughly how far it is from `message`.

The server writes one page at a time, so length drives the wait: keep lessons
concise (see the templates).

On success:

```json
{ "status": "succeeded", "done": true,
  "result": { "classroomId": "Xy12AbCd9Q",
              "url": "https://<your-host>.<tailnet>.ts.net/classroom/Xy12AbCd9Q",
              "scenesCount": 12 } }
```

Give the person `result.url`. The lesson is also in the parent's library
(and in each `shareWith` member's "Shared with me"). On `failed`, report
`error` and do not retry automatically.

### Cancelling

There is no cancel endpoint. If the person wants to stop a lesson that is
being generated, tell them the parent (operator) has to stop it on the
server. A stopped job ends as `failed` with `error` "Cancelled by the
parent": report that and do not resubmit unless the person asks.

## Errors

| Status | Meaning | What to do |
|---|---|---|
| `400` | A field or file is wrong; `error` says which | Fix it or tell the person (e.g. "that member hasn't opened the site yet") |
| `401` | Missing or wrong token | Stop; ask the operator for the token |
| `404` | Not allowed | Stop; the token or identity cannot do this |
| `413` | Files too large | Ask for smaller files or fewer pages |

## Requirement templates

Lessons should be concise: as many pages as the topic needs, not more. The
templates ask for about 5–6 pages for a simple topic and at most about 10–12
for a complex one.

Year 8 (KS3):

```
Teach the attached material to a UK Year 8 (KS3) student.
Keep the lesson concise: use only as many pages as the topic needs (about 5-6 pages for a simple topic, at most about 10-12 for a complex one). Combine closely related ideas on one slide and leave out anything the student does not need.
1. First work out what topic and skills the material covers.
2. Explain each key idea step by step in simple words, using worked examples taken from the material.
3. After each main part, add a short quiz of 4-5 questions of the SAME type as the material but with different numbers or examples. Group small parts together instead of adding a quiz for every small idea. Mix multiple choice and short answers, and show the working in every explanation.
4. If the lesson has more than one main part, finish with a mixed quiz of 6-8 questions from easy to hard.
```

GCSE (replace the subject and tier):

```
Teach the attached material to a UK Year 11 student sitting GCSE [Maths Higher] this summer.
Keep the lesson concise: use only as many pages as the topic needs (about 5-6 pages for a simple topic, at most about 10-12 for a complex one). Combine closely related ideas on one slide and leave out anything the student does not need.
1. First work out what topic and skills the material covers.
2. Explain each key idea step by step in simple words, using worked examples taken from the material.
3. After each main part, add a short quiz of 4-5 GCSE exam-style questions of the SAME type as the material but with different numbers or examples. Group small parts together instead of adding a quiz for every small idea. Show the marks for each question, mix multiple choice and short answers, and give mark-scheme style working in every explanation, including common mistakes.
4. If the lesson has more than one main part, finish with a mixed exam-style quiz of 6-8 questions from easy to hard.
```

No files, just a topic: replace "the attached material" with the topic, e.g.
"Teach solving linear equations to a UK Year 8 (KS3) student."

Only a part of the material: add a line such as
"Only cover Sections B and C of the worksheet."

## Rules

1. One job at a time for a person; never submit a second job while one is
   `queued` or `running`.
2. Use `grok-4.7-medium` for maths and anything with right/wrong answers.
   Use the concise templates above unless the person asks for a longer lesson.
3. Only add `shareWith` or `owner` when the person asks.
4. Send the link only after `status` is `succeeded`.
5. Never reveal the token.
