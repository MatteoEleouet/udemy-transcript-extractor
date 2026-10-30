/**
 * Downloading a Udemy course's subtitles and resources — the network half.
 *
 * `udemy-course.ts` decides what goes where; this file fetches it. It runs in
 * the dashboard, a full tab, because a course is hundreds of files and the
 * popup is destroyed the moment it loses focus.
 *
 * ## Three kinds of request, from three places
 *
 * - **Course API** (`/api-2.0/…`): needs the student's session, so it is made
 *   by the content script in the Udemy tab — see `UDEMY_API_GET`. The
 *   extension never holds a Udemy token.
 * - **Caption files** (`*.udemycdn.com`): public CDN objects, read from here
 *   so they can be converted to SRT or text and imported into the library.
 * - **Resource files**: signed, short-lived CDN links, asked for one at a time
 *   just before each download. In folder mode Chrome downloads them itself,
 *   which streams to disk however large they are; only ZIP mode reads them
 *   into memory.
 *
 * The optional `downloads` permission and the CDN host are requested when the
 * user starts a download, not at install: most people never use this, and
 * they should not have to grant it to use the rest.
 */

import { ExtensionService } from './extension-service';
import { parseCaptionFile, toBracketTranscript, toSRT } from './caption-formats';
import { createZip, textBytes, type ZipEntry } from './zip';
import { courseIdFromUrl } from './library-schema';
import { lectureId } from './collection';
import { importCourseLectures, type ImportedLecture } from './library-db';
import {
  allLectures,
  articleHtml,
  buildCourseIndex,
  buildCourseManifest,
  lectureUrl,
  parseCurriculum,
  pickDownloadUrl,
  planCourseDownload,
  type CourseCurriculum,
  type DownloadOptions,
  type DownloadPlan,
  type FileOutcome,
  type PlannedFile,
  type RawCurriculumItem,
} from './udemy-course';

export const DOWNLOAD_PERMISSIONS: chrome.permissions.Permissions = {
  permissions: ['downloads'],
  origins: ['https://*.udemycdn.com/*'],
};

/** At most this many requests in flight — enough to be quick, few enough not to be throttled. */
const CONCURRENCY = 3;

export interface UdemyTab {
  tabId: number;
  title: string;
  url: string;
}

/** Udemy course pages open in this browser, most recently used first. */
export async function findUdemyCourseTabs(): Promise<UdemyTab[]> {
  if (typeof chrome === 'undefined' || !chrome.tabs) return [];
  const tabs = await chrome.tabs.query({ url: 'https://*.udemy.com/course/*' });
  return tabs
    .filter((tab) => tab.id !== undefined && tab.url)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .map((tab) => ({ tabId: tab.id!, title: tab.title ?? tab.url!, url: tab.url! }));
}

interface ContentReply<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function ask<T>(tabId: number, message: unknown): Promise<T> {
  const reply = await ExtensionService.sendToTab<ContentReply<T>>(tabId, message);
  if (!reply?.success) throw new Error(reply?.error ?? 'The Udemy tab did not answer.');
  return reply.data as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET one API path through the Udemy tab, retrying when throttled.
 *
 * Udemy answers bursts with 429 and occasionally 5xx; both pass with a wait.
 * A 403 does not — it means the course is not one this student can open.
 */
async function apiGet<T>(tabId: number, path: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    const { status, json } = await ask<{ status: number; json: unknown }>(tabId, {
      type: 'UDEMY_API_GET',
      data: { path },
    });
    if (status >= 200 && status < 300) return json as T;

    const retryable = status === 429 || status >= 500;
    if (!retryable || attempt >= 3) {
      if (status === 401 || status === 403) {
        throw new Error(`Udemy refused the request (HTTP ${status}). Are you signed in and enrolled?`);
      }
      throw new Error(`Udemy API returned HTTP ${status}.`);
    }
    await sleep(1000 * 2 ** attempt);
  }
}

interface CourseContext {
  origin: string;
  slug: string | null;
  courseId: number | null;
  title: string | null;
}

/** The course id from its slug, for when the page does not carry it. */
async function resolveCourseId(tabId: number, slug: string): Promise<number> {
  try {
    const course = await apiGet<{ id?: number }>(
      tabId,
      `/api-2.0/courses/${encodeURIComponent(slug)}/?fields[course]=id`,
    );
    if (course?.id) return course.id;
  } catch {
    // Some accounts cannot read the public course endpoint; try enrolments.
  }

  const enrolled = await apiGet<{ results?: { id: number; url?: string }[] }>(
    tabId,
    `/api-2.0/users/me/subscribed-courses/?page_size=100&fields[course]=id,url&search=${encodeURIComponent(slug.replace(/-/g, ' '))}`,
  );
  const match = enrolled?.results?.find((course) => course.url?.includes(`/course/${slug}/`));
  if (!match) throw new Error('Could not find this course among your enrolments.');
  return match.id;
}

const CURRICULUM_FIELDS = [
  'fields[lecture]=title,object_index,asset,supplementary_assets',
  'fields[chapter]=title,object_index',
  'fields[quiz]=title,object_index,type',
  'fields[practice]=title,object_index',
  'fields[asset]=title,filename,asset_type,time_estimation,external_url,captions',
].join('&');

/** Read the whole curriculum of the course open in `tabId`. */
export async function loadCurriculum(tabId: number): Promise<CourseCurriculum> {
  const context = await ask<CourseContext>(tabId, { type: 'UDEMY_COURSE_CONTEXT' });
  if (!context.slug) throw new Error('This tab is not a Udemy course page.');

  const courseId = context.courseId ?? (await resolveCourseId(tabId, context.slug));

  let title = context.title;
  if (!title) {
    const course = await apiGet<{ title?: string }>(
      tabId,
      `/api-2.0/courses/${courseId}/?fields[course]=title`,
    ).catch(() => null);
    title = course?.title ?? context.slug;
  }

  const items: RawCurriculumItem[] = [];
  let next: string | null =
    `/api-2.0/courses/${courseId}/subscriber-curriculum-items/?page_size=200&${CURRICULUM_FIELDS}`;

  while (next) {
    const page: { results?: RawCurriculumItem[]; next?: string | null } = await apiGet(tabId, next);
    items.push(...(page.results ?? []));
    // `next` comes back absolute; the content script only takes a path.
    next = page.next ? new URL(page.next).pathname + new URL(page.next).search : null;
  }

  return parseCurriculum(items, { courseId, title, origin: context.origin, slug: context.slug });
}

/* -------------------------------------------------------------------------- */
/* Writing files                                                               */
/* -------------------------------------------------------------------------- */

export type OutputMode = 'folder' | 'zip';

export interface DownloadProgress {
  done: number;
  total: number;
  current?: string;
  failed: number;
}

export interface RunOptions {
  mode: OutputMode;
  /** Import this locale's subtitles into the library as transcripts. */
  importLocale?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadReport {
  root: string;
  saved: number;
  failures: { path: string; reason: string }[];
  imported?: { added: number; kept: number };
  cancelled: boolean;
}

/** Where a planned file's bytes come from. */
type Payload = { url: string } | { text: string; mime: string } | { bytes: Uint8Array; mime: string };

interface Sink {
  write(path: string, payload: Payload, signal?: AbortSignal): Promise<void>;
  finish(): Promise<void>;
}

/** Wait for a Chrome download to finish, so failures can be reported. */
function awaitDownload(id: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      chrome.downloads.onChanged.removeListener(listener);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') done();
      if (delta.state.current === 'interrupted') {
        chrome.downloads.search({ id }).then(
          ([item]) => done(new Error(item?.error ? `download ${item.error.toLowerCase()}` : 'download interrupted')),
          () => done(new Error('download interrupted')),
        );
      }
    };
    const onAbort = () => done(new DOMException('Cancelled', 'AbortError'));
    // A large file still going after this long is left to Chrome rather than
    // holding up the rest of the course; it shows in the downloads bar.
    const timer = setTimeout(() => done(), 10 * 60_000);

    chrome.downloads.onChanged.addListener(listener);
    signal?.addEventListener('abort', onAbort);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === 'complete') done();
    }, () => undefined);
  });
}

/** Each file straight into Downloads/<root>/…, via Chrome's own downloader. */
function folderSink(root: string): Sink {
  return {
    async write(path, payload, signal) {
      let url: string;
      let revoke: (() => void) | null = null;
      if ('url' in payload) {
        url = payload.url;
      } else {
        const blob = new Blob(['text' in payload ? payload.text : (payload.bytes as BlobPart)], {
          type: payload.mime,
        });
        url = URL.createObjectURL(blob);
        revoke = () => URL.revokeObjectURL(url);
      }
      try {
        const id = await chrome.downloads.download({
          url,
          filename: `${root}/${path}`,
          conflictAction: 'overwrite',
          saveAs: false,
        });
        await awaitDownload(id, signal);
      } finally {
        if (revoke) setTimeout(revoke, 60_000);
      }
    },
    async finish() {},
  };
}

/**
 * Everything in one archive.
 *
 * A resource the CDN will not hand to the extension is not lost: it is
 * downloaded beside the archive under the same relative path, and the index
 * still points at it.
 */
function zipSink(root: string): Sink {
  const entries: ZipEntry[] = [];
  const fallback = folderSink(root);
  const prefix = root.slice(root.lastIndexOf('/') + 1);

  return {
    async write(path, payload, signal) {
      if ('text' in payload) {
        entries.push({ name: `${prefix}/${path}`, data: textBytes(payload.text) });
        return;
      }
      if ('bytes' in payload) {
        entries.push({ name: `${prefix}/${path}`, data: payload.bytes });
        return;
      }
      try {
        const response = await fetch(payload.url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        entries.push({ name: `${prefix}/${path}`, data: new Uint8Array(await response.arrayBuffer()) });
      } catch (error) {
        if (signal?.aborted) throw error;
        await fallback.write(path, payload, signal);
      }
    },
    async finish() {
      const archive = createZip(entries);
      const blob = new Blob([archive as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      try {
        const id = await chrome.downloads.download({
          url,
          filename: `${root}.zip`,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        await awaitDownload(id);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/** Run `task` over `items`, `limit` at a time, stopping early on abort. */
async function eachLimited<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Download everything the plan lists.
 *
 * One failure never stops the course: an expired link or a deleted resource is
 * recorded, shown at the end and marked in the index, and the rest carries on.
 */
export async function runCourseDownload(
  tabId: number,
  curriculum: CourseCurriculum,
  options: DownloadOptions,
  run: RunOptions,
): Promise<DownloadReport> {
  const plan: DownloadPlan = planCourseDownload(curriculum, options);
  const sink = run.mode === 'zip' ? zipSink(plan.root) : folderSink(plan.root);
  const outcomes = new Map<string, FileOutcome>();
  const failures: { path: string; reason: string }[] = [];
  const captionCache = new Map<string, Promise<string>>();
  const transcripts = new Map<number, string>();
  const progress: DownloadProgress = { done: 0, total: plan.files.length + 2, failed: 0 };
  const signal = run.signal;

  const report = () => run.onProgress?.({ ...progress });

  /** One fetch per caption track, however many formats are written from it. */
  const captionText = (url: string) => {
    let pending = captionCache.get(url);
    if (!pending) {
      pending = fetch(url, { signal }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      });
      captionCache.set(url, pending);
    }
    return pending;
  };

  const lectureAsset = (lectureId: number) =>
    apiGet<{ asset?: { body?: string; download_urls?: unknown } }>(
      tabId,
      `/api-2.0/users/me/subscribed-courses/${curriculum.courseId}/lectures/${lectureId}/?fields[lecture]=asset&fields[asset]=body,download_urls,filename,asset_type`,
      signal,
    );

  const payloadFor = async (file: PlannedFile): Promise<Payload> => {
    switch (file.kind) {
      case 'links':
        return { text: file.text, mime: 'text/markdown' };

      case 'caption': {
        const source = await captionText(file.url);
        if (file.format === 'vtt') return { text: source, mime: 'text/vtt' };
        const cues = parseCaptionFile(source);
        if (cues.length === 0) throw new Error('empty subtitle track');
        return file.format === 'srt'
          ? { text: toSRT(cues), mime: 'application/x-subrip' }
          : { text: `${toBracketTranscript(cues)}\n`, mime: 'text/plain' };
      }

      case 'article': {
        const lecture = await lectureAsset(file.lectureId);
        const body = lecture?.asset?.body;
        if (!body) throw new Error('article has no body');
        return { text: articleHtml(file.title, body), mime: 'text/html' };
      }

      case 'resource': {
        const asset = file.main
          ? (await lectureAsset(file.lectureId))?.asset
          : await apiGet<{ download_urls?: unknown }>(
              tabId,
              `/api-2.0/users/me/subscribed-courses/${curriculum.courseId}/lectures/${file.lectureId}/supplementary-assets/${file.assetId}/?fields[asset]=download_urls,filename,title`,
              signal,
            );
        const url = pickDownloadUrl(asset?.download_urls);
        if (!url) throw new Error('Udemy offers no download for this resource');
        return { url };
      }
    }
  };

  report();

  try {
    await eachLimited(
      plan.files,
      CONCURRENCY,
      async (file) => {
        progress.current = file.path;
        report();
        try {
          await sink.write(file.path, await payloadFor(file), signal);
          outcomes.set(file.path, { status: 'saved' });
        } catch (error) {
          if (signal?.aborted) return;
          const reason = reasonOf(error);
          outcomes.set(file.path, { status: 'failed', reason });
          failures.push({ path: file.path, reason });
          progress.failed += 1;
        }
        progress.done += 1;
        report();
      },
      signal,
    );

    // Library import reads the chosen locale whether or not it was also
    // written to disk; the cache makes that free when it was.
    if (run.importLocale && !signal?.aborted) {
      progress.current = 'Adding transcripts to your library';
      report();
      await eachLimited(
        allLectures(curriculum),
        CONCURRENCY,
        async (lecture) => {
          const track =
            lecture.captions.find((c) => c.locale === run.importLocale && !c.auto) ??
            lecture.captions.find((c) => c.locale === run.importLocale);
          if (!track) return;
          try {
            const cues = parseCaptionFile(await captionText(track.url));
            if (cues.length > 0) transcripts.set(lecture.id, toBracketTranscript(cues));
          } catch {
            // A lecture without readable captions is simply not imported.
          }
        },
        signal,
      );
    }
    progress.done += 1;

    if (signal?.aborted) {
      return { root: plan.root, saved: countSaved(outcomes), failures, cancelled: true };
    }

    progress.current = 'Writing the course index';
    report();
    await sink.write('README.md', { text: buildCourseIndex(curriculum, plan, outcomes), mime: 'text/markdown' });
    await sink.write('course.json', {
      text: buildCourseManifest(curriculum, plan, outcomes),
      mime: 'application/json',
    });
    await sink.finish();
    progress.done += 1;
    progress.current = undefined;
    report();
  } catch (error) {
    if (signal?.aborted) {
      return { root: plan.root, saved: countSaved(outcomes), failures, cancelled: true };
    }
    throw error;
  }

  let imported: DownloadReport['imported'];
  if (run.importLocale && transcripts.size > 0) {
    const url = lectureUrl(curriculum, allLectures(curriculum)[0].id);
    const lectures: ImportedLecture[] = allLectures(curriculum)
      .filter((lecture) => transcripts.has(lecture.id))
      .map((lecture) => {
        const lectureLink = lectureUrl(curriculum, lecture.id);
        return {
          // The same identity extraction gives this lecture, so a lecture
          // already in the library is matched rather than duplicated.
          id: lectureId(lectureLink, lectureLink),
          title: lecture.title,
          url: lectureLink,
          order: lecture.index,
          durationSeconds: lecture.durationSeconds,
          transcript: transcripts.get(lecture.id)!,
        };
      });
    imported = await importCourseLectures(courseIdFromUrl(url), { courseTitle: curriculum.title }, lectures);
  }

  return { root: plan.root, saved: countSaved(outcomes), failures, imported, cancelled: false };
}

function countSaved(outcomes: Map<string, FileOutcome>): number {
  let saved = 0;
  for (const outcome of outcomes.values()) if (outcome.status === 'saved') saved += 1;
  return saved;
}
