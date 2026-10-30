import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The network half, end to end, against fakes of the three things it talks to:
 * the Udemy tab (course API), the CDN (caption files) and chrome.downloads.
 * What is worth pinning down is the flow — pagination, retry on throttling,
 * one failure not stopping the course, the index written last.
 */

const sendToTab = vi.fn();
vi.mock('./extension-service', () => ({ ExtensionService: { sendToTab } }));

const importCourseLectures = vi.fn(async () => ({ added: 2, kept: 0 }));
vi.mock('./library-db', () => ({ importCourseLectures }));

const { loadCurriculum, runCourseDownload } = await import('./course-download');
const { DEFAULT_DOWNLOAD_OPTIONS } = await import('./udemy-course');

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello there\n\n00:00:04.000 --> 00:00:06.000\nGeneral Kenobi\n';

const PAGE_ONE = {
  next: 'https://www.udemy.com/api-2.0/courses/42/subscriber-curriculum-items/?page=2',
  results: [
    { _class: 'chapter', id: 1, title: 'Start', object_index: 1 },
    {
      _class: 'lecture',
      id: 100,
      title: 'Welcome',
      object_index: 1,
      asset: { id: 1, asset_type: 'Video', captions: [{ locale_id: 'en_US', video_label: 'English', url: 'https://vtt-c.udemycdn.com/100.vtt' }] },
      supplementary_assets: [
        { id: 500, asset_type: 'File', title: 'Slides', filename: 'slides.pdf' },
        { id: 501, asset_type: 'File', title: 'Gone', filename: 'gone.zip' },
      ],
    },
  ],
};

const PAGE_TWO = {
  next: null,
  results: [
    {
      _class: 'lecture',
      id: 101,
      title: 'Next',
      object_index: 2,
      asset: { id: 2, asset_type: 'Video', captions: [{ locale_id: 'en_US', video_label: 'English', url: 'https://vtt-c.udemycdn.com/101.vtt' }] },
    },
  ],
};

let throttled = 0;

function api(path: string): { status: number; json: unknown } {
  if (path.includes('subscriber-curriculum-items')) {
    if (path.includes('page=2')) return { status: 200, json: PAGE_TWO };
    // The first read is throttled once, which must be retried, not reported.
    if (throttled++ === 0) return { status: 429, json: null };
    return { status: 200, json: PAGE_ONE };
  }
  if (path.includes('supplementary-assets/500')) {
    return { status: 200, json: { download_urls: { File: [{ label: 'download', file: 'https://att-c.udemycdn.com/slides.pdf?sig=1' }] } } };
  }
  if (path.includes('supplementary-assets/501')) return { status: 200, json: { download_urls: null } };
  return { status: 404, json: null };
}

const downloads: { url: string; filename: string }[] = [];
let nextId = 1;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  throttled = 0;
  downloads.length = 0;
  sendToTab.mockImplementation(async (_tab: number, message: { type: string; data?: { path: string } }) => {
    if (message.type === 'UDEMY_COURSE_CONTEXT') {
      return { success: true, data: { origin: 'https://www.udemy.com', slug: 'python', courseId: 42, title: 'Python' } };
    }
    return { success: true, data: api(message.data!.path) };
  });

  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('.vtt') ? VTT : 'x')));
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
  vi.stubGlobal('chrome', {
    downloads: {
      download: vi.fn(async (options: { url: string; filename: string }) => {
        downloads.push(options);
        return nextId++;
      }),
      // Every download reports itself complete immediately.
      search: vi.fn(async () => [{ state: 'complete' }]),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  // Retries wait on setTimeout; run them out while the promise settles.
  let done = false;
  const result = promise.finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(1000);
  return result;
}

describe('loadCurriculum', () => {
  it('follows pagination and retries a throttled page', async () => {
    const curriculum = await settle(loadCurriculum(7));
    expect(curriculum.courseId).toBe(42);
    expect(curriculum.sections[0].lectures.map((l) => l.id)).toEqual([100, 101]);
    // The absolute `next` URL is handed to the tab as a path only.
    expect(sendToTab).toHaveBeenCalledWith(7, {
      type: 'UDEMY_API_GET',
      data: { path: '/api-2.0/courses/42/subscriber-curriculum-items/?page=2' },
    });
  });
});

describe('runCourseDownload', () => {
  it('saves everything it can, reports the rest, and indexes it all', async () => {
    const curriculum = await settle(loadCurriculum(7));
    const report = await settle(
      runCourseDownload(7, curriculum, DEFAULT_DOWNLOAD_OPTIONS, { mode: 'folder', importLocale: 'en_US' }),
    );

    const names = downloads.map((d) => d.filename);
    expect(names).toContain('Udemy/Python/01 - Start/001 - Welcome/001 - Welcome.en_US.srt');
    expect(names).toContain('Udemy/Python/01 - Start/001 - Welcome/slides.pdf');
    expect(names.at(-2)).toBe('Udemy/Python/README.md');
    expect(names.at(-1)).toBe('Udemy/Python/course.json');

    // The resource goes to Chrome as its signed URL, not through memory.
    expect(downloads.find((d) => d.filename.endsWith('slides.pdf'))?.url).toBe(
      'https://att-c.udemycdn.com/slides.pdf?sig=1',
    );

    expect(report.failures).toEqual([
      { path: '01 - Start/001 - Welcome/gone.zip', reason: 'Udemy offers no download for this resource' },
    ]);
    expect(report.cancelled).toBe(false);

    // Captions become transcripts, keyed like extracted lectures.
    expect(importCourseLectures).toHaveBeenCalledWith(
      'course:https://www.udemy.com/course/python',
      { courseTitle: 'Python' },
      expect.arrayContaining([
        expect.objectContaining({
          id: 'https://www.udemy.com/course/python/learn/lecture/100',
          order: 1,
          transcript: '[00:01] Hello there\n\n[00:04] General Kenobi',
        }),
      ]),
    );
  });

  it('fetches each caption track once, whatever the number of formats', async () => {
    const curriculum = await settle(loadCurriculum(7));
    await settle(runCourseDownload(7, curriculum, DEFAULT_DOWNLOAD_OPTIONS, { mode: 'folder', importLocale: 'en_US' }));
    const captionFetches = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).endsWith('.vtt'),
    );
    expect(captionFetches).toHaveLength(2);
  });

  it('builds one archive in ZIP mode', async () => {
    const curriculum = await settle(loadCurriculum(7));
    await settle(runCourseDownload(7, curriculum, DEFAULT_DOWNLOAD_OPTIONS, { mode: 'zip' }));
    expect(downloads.map((d) => d.filename)).toEqual(['Udemy/Python.zip']);
  });
});
