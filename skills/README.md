# Fundo Plus — Skills Folder

This folder gives Prok AI extra context for study sessions.

## Structure

```
skills/
  README.md              ← this file
  zimsec-guide.md        ← General ZIMSEC exam tips
  maths-formulas.md      ← Key maths formulae
  syllabus/              ← Syllabus JSON files (one per subject)
    maths-olevel.json
    physics-olevel.json
    ...
  projects/              ← AI-generated study projects (auto-saved)
```

## Adding Custom Skills

Place any `.md`, `.txt`, or `.json` file in `skills/` and the AI will
read it before answering questions in the Skills & Study panel.

## Syllabus Format (JSON)

```json
{
  "id": "maths-olevel",
  "name": "Mathematics O-Level",
  "level": "O-Level",
  "board": "ZIMSEC",
  "topics": ["Algebra", "Geometry", "Trigonometry", "Statistics"],
  "description": "Optional description of the syllabus."
}
```
