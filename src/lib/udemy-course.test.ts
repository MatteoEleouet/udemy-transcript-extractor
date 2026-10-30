import { describe, expect, it } from 'vitest';
import {
  buildCourseIndex,
  buildCourseManifest,
  captionLocales,
  parseCurriculum,
  pickDownloadUrl,
  planCourseDownload,
  safeFilename,
  safeSegment,
  DEFAULT_DOWNLOAD_OPTIONS,
  type FileOutcome,
  type RawCurriculumItem,
} from './udemy-course';

const COURSE = { courseId: 42, title: 'Python: Zero to Hero', origin: 'https://www.udemy.com', slug: 'python' };

const ITEMS: RawCurriculumItem[] = [
  { _class: 'chapter', id: 1, title: 'Getting started', object_index: 1 },
  {
    _class: 'lecture',
    id: 100,
    title: 'Welcome',
    object_index: 1,
    asset: {
      id: 9100,
      asset_type: 'Video',
      time_estimation: 300,
      captions: [
        { locale_id: 'en_US', video_label: 'English', url: 'https://vtt-c.udemycdn.com/a.vtt', source: 'manual' },
        { locale_id: 'fr_FR', video_label: 'French [Auto]', url: 'https://vtt-c.udemycdn.com/b.vtt', source: 'auto' },
      ],
    },
    supplementary_assets: [
      { id: 5001, asset_type: 'File', title: 'Slides', filename: 'slides.pdf' },
      { id: 5002, asset_type: 'File', title: 'Slides again', filename: 'Slides.pdf' },
      { id: 5003, asset_type: 'ExternalLink', title: 'Docs', external_url: 'https://docs.python.org' },
    ],
  },
  { _class: 'quiz', id: 7, title: 'Check yourself', object_index: 1 },
  { _class: 'chapter', id: 2, title: 'Data: types / values', object_index: 2 },
  {
    _class: 'lecture',
    id: 101,
    title: 'Cheat sheet',
    object_index: 2,
    asset: { id: 9101, asset_type: 'E-Book', filename: 'cheatsheet.pdf' },
  },
  { _class: 'lecture', id: 102, title: 'Read this first', object_index: 3, asset: { id: 9102, asset_type: 'Article' } },
];

describe('parseCurriculum', () => {
  const curriculum = parseCurriculum(ITEMS, COURSE);

  it('groups lectures under the chapter before them', () => {
    expect(curriculum.sections.map((s) => s.title)).toEqual(['Getting started', 'Data: types / values']);
    expect(curriculum.sections[0].lectures.map((l) => l.id)).toEqual([100]);
    expect(curriculum.sections[1].lectures.map((l) => l.id)).toEqual([101, 102]);
  });

  it('keeps quizzes as activities, not lectures', () => {
    expect(curriculum.sections[0].activities).toEqual([{ kind: 'quiz', index: 1, title: 'Check yourself' }]);
  });

  it('marks auto-generated captions', () => {
    const [en, fr] = curriculum.sections[0].lectures[0].captions;
    expect(en.auto).toBe(false);
    expect(fr.auto).toBe(true);
  });

  it('separates links from files', () => {
    const kinds = curriculum.sections[0].lectures[0].resources.map((r) => r.kind);
    expect(kinds).toEqual(['file', 'file', 'link']);
  });

  it('treats a document lecture as having a file of its own, a video as not', () => {
    expect(curriculum.sections[1].lectures[0].mainFilename).toBe('cheatsheet.pdf');
    expect(curriculum.sections[0].lectures[0].mainFilename).toBeUndefined();
  });

  it('gives lectures before any chapter a section instead of dropping them', () => {
    const orphan = parseCurriculum([{ _class: 'lecture', id: 1, title: 'Hi', object_index: 1 }], COURSE);
    expect(orphan.sections).toHaveLength(1);
    expect(orphan.sections[0].lectures).toHaveLength(1);
  });
});

describe('captionLocales', () => {
  it('counts lectures per locale and keeps the auto flag', () => {
    const locales = captionLocales(parseCurriculum(ITEMS, COURSE));
    expect(locales).toEqual([
      { locale: 'en_US', label: 'English', lectures: 1, auto: false },
      { locale: 'fr_FR', label: 'French', lectures: 1, auto: true },
    ]);
  });
});

describe('safe names', () => {
  it('removes characters no file system accepts', () => {
    expect(safeSegment('Data: types / values?')).toBe('Data types values');
  });

  it('strips trailing dots and leading dots', () => {
    expect(safeSegment('...hidden. ')).toBe('hidden');
  });

  it('escapes reserved Windows names', () => {
    expect(safeSegment('CON')).toBe('_CON');
  });

  it('avoids names Chrome refuses to download to', () => {
    expect(safeSegment('~temp')).toBe('temp');
    expect(safeSegment('desktop.ini')).toBe('desktop.ini_');
    expect(safeFilename('shortcut.lnk')).toBe('shortcut.lnk_');
  });

  it('falls back when nothing is left', () => {
    expect(safeSegment('???', 80, 'x')).toBe('x');
  });

  it('keeps the extension when shortening a file name', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    const safe = safeFilename(long, 50);
    expect(safe.endsWith('.pdf')).toBe(true);
    expect(safe.length).toBeLessThanOrEqual(50);
  });
});

describe('planCourseDownload', () => {
  const curriculum = parseCurriculum(ITEMS, COURSE);
  const plan = planCourseDownload(curriculum, DEFAULT_DOWNLOAD_OPTIONS);
  const paths = plan.files.map((f) => f.path);

  it('puts the course under Udemy/<title>', () => {
    expect(plan.root).toBe('Udemy/Python Zero to Hero');
  });

  it('numbers sections and lectures from the course itself', () => {
    expect(plan.lectures[0].folder).toBe('01 - Getting started/001 - Welcome');
    expect(plan.lectures[1].folder).toBe('02 - Data types values/002 - Cheat sheet');
  });

  it('names subtitles after the lecture, by locale and format', () => {
    expect(paths).toContain('01 - Getting started/001 - Welcome/001 - Welcome.en_US.srt');
    expect(paths).toContain('01 - Getting started/001 - Welcome/001 - Welcome.en_US.vtt');
    expect(paths).toContain('01 - Getting started/001 - Welcome/001 - Welcome.fr_FR.auto.srt');
  });

  it('keeps resources in their lecture folder and never collides', () => {
    expect(paths).toContain('01 - Getting started/001 - Welcome/slides.pdf');
    expect(paths).toContain('01 - Getting started/001 - Welcome/Slides (2).pdf');
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(paths.length);
  });

  it('writes links to a file rather than downloading them', () => {
    const links = plan.files.find((f) => f.kind === 'links');
    expect(links?.kind === 'links' && links.text).toContain('https://docs.python.org');
  });

  it('plans document lectures and articles', () => {
    expect(paths).toContain('02 - Data types values/002 - Cheat sheet/cheatsheet.pdf');
    expect(paths).toContain('02 - Data types values/003 - Read this first/003 - Read this first.html');
  });

  it('keeps paths short enough for Windows', () => {
    const long = 'An extremely long title that goes on and on about many things';
    const wordy = parseCurriculum(
      [
        { _class: 'chapter', id: 1, title: long, object_index: 1 },
        {
          _class: 'lecture',
          id: 1,
          title: long,
          object_index: 1,
          asset: { asset_type: 'Video', captions: [{ locale_id: 'en_US', url: 'https://x/a.vtt', source: 'auto' }] },
          supplementary_assets: [{ id: 2, asset_type: 'File', filename: `${long} ${long}.pdf` }],
        },
      ],
      { ...COURSE, title: long },
    );
    const longPlan = planCourseDownload(wordy, DEFAULT_DOWNLOAD_OPTIONS);
    for (const file of longPlan.files) {
      expect(`${longPlan.root}/${file.path}`.length).toBeLessThanOrEqual(232);
    }
  });

  it('respects the chosen locales and formats', () => {
    const only = planCourseDownload(curriculum, {
      ...DEFAULT_DOWNLOAD_OPTIONS,
      locales: ['fr_FR'],
      subtitleFormats: ['txt'],
      resources: false,
      links: false,
      articles: false,
    });
    expect(only.files.map((f) => f.path)).toEqual([
      '01 - Getting started/001 - Welcome/001 - Welcome.fr_FR.auto.txt',
    ]);
  });
});

describe('index and manifest', () => {
  const curriculum = parseCurriculum(ITEMS, COURSE);
  const plan = planCourseDownload(curriculum, DEFAULT_DOWNLOAD_OPTIONS);
  const outcomes = new Map<string, FileOutcome>(
    plan.files.map((f) => [f.path, { status: 'saved' } as FileOutcome]),
  );
  outcomes.set('01 - Getting started/001 - Welcome/slides.pdf', { status: 'failed', reason: 'HTTP 403' });

  it('links saved files from their lecture and explains failures', () => {
    const index = buildCourseIndex(curriculum, plan, outcomes, new Date('2026-01-01'));
    expect(index).toContain('## 1. Getting started');
    expect(index).toContain('[001 - Welcome.en_US.srt](<01 - Getting started/001 - Welcome/001 - Welcome.en_US.srt>)');
    expect(index).toContain('slides.pdf — _not downloaded: HTTP 403_');
    expect(index).toContain('Check yourself _(quiz, online only)_');
    expect(index).toContain('https://www.udemy.com/course/python/learn/lecture/100');
  });

  it('records the same mapping as JSON', () => {
    const manifest = JSON.parse(buildCourseManifest(curriculum, plan, outcomes));
    expect(manifest.sections[0].lectures[0].folder).toBe('01 - Getting started/001 - Welcome');
    expect(manifest.sections[0].lectures[0].links).toEqual([{ title: 'Docs', url: 'https://docs.python.org' }]);
  });
});

describe('pickDownloadUrl', () => {
  it('finds the file whatever the asset-type key', () => {
    expect(pickDownloadUrl({ 'E-Book': [{ label: 'download', file: 'https://cdn/x.pdf' }] })).toBe('https://cdn/x.pdf');
  });

  it('returns null when there is nothing usable', () => {
    expect(pickDownloadUrl(null)).toBeNull();
    expect(pickDownloadUrl({ File: [{ label: 'download' }] })).toBeNull();
  });
});
