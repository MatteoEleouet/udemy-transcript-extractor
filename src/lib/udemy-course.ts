/**
 * A Udemy course as files on disk — the pure half of the course download.
 *
 * Extracting one lecture at a time reads what the player renders, which is why
 * collecting a course means walking it. Udemy's own web app does not work that
 * way: the curriculum, every caption track and every attached resource are
 * listed by its API, the same one the page calls with the user's session. So a
 * whole course can be described in a handful of requests, without navigating
 * anywhere.
 *
 * This file turns that description into a plan: which file goes where. The
 * layout is what makes the download useful rather than a pile of
 * `slides(3).pdf` in a Downloads folder:
 *
 *   Udemy/<Course>/
 *     README.md                        ← index: every lecture, every file
 *     course.json                      ← the same, for scripts
 *     01 - <Section>/
 *       001 - <Lecture>/
 *         001 - <Lecture>.en_US.srt    ← named after the lecture, so a player
 *         001 - <Lecture>.en_US.vtt       pairs it with a video of that name
 *         slides.pdf                   ← resources keep their own names, in
 *         links.md                        the folder of the lecture they
 *                                         belong to
 *
 * Numbers come from Udemy's own `object_index`, so `017` here is lecture 17 in
 * the course player too.
 *
 * Pure functions, no DOM, no `chrome` — the network half is `course-download.ts`.
 */

/* -------------------------------------------------------------------------- */
/* What the API returns                                                        */
/* -------------------------------------------------------------------------- */

export interface RawCaption {
  id?: number;
  locale_id?: string;
  video_label?: string;
  title?: string;
  url?: string;
  source?: string;
  status?: number;
}

export interface RawAsset {
  id?: number;
  asset_type?: string;
  title?: string;
  filename?: string;
  time_estimation?: number;
  external_url?: string;
  captions?: RawCaption[];
}

export interface RawCurriculumItem {
  _class?: string;
  id?: number;
  title?: string;
  object_index?: number;
  asset?: RawAsset | null;
  supplementary_assets?: RawAsset[] | null;
}

/* -------------------------------------------------------------------------- */
/* The course, as this extension holds it                                      */
/* -------------------------------------------------------------------------- */

export interface CourseCaption {
  /** Udemy's locale id, e.g. `en_US`. */
  locale: string;
  /** Human label, e.g. `English [Auto]`. */
  label: string;
  /** Machine-generated rather than written by the instructor. */
  auto: boolean;
  url: string;
}

export interface CourseResource {
  assetId: number;
  title: string;
  filename?: string;
  assetType: string;
  kind: 'file' | 'link';
  externalUrl?: string;
}

export interface CourseLecture {
  id: number;
  /** Position in the whole course, as Udemy numbers it. */
  index: number;
  title: string;
  assetType: string;
  assetId?: number;
  /** The lecture's own file, for lectures that are a document rather than a video. */
  mainFilename?: string;
  durationSeconds?: number;
  captions: CourseCaption[];
  resources: CourseResource[];
}

/** Quizzes, exercises and practice tests: listed in the index, nothing to download. */
export interface CourseActivity {
  kind: string;
  index: number;
  title: string;
}

export interface CourseSection {
  index: number;
  title: string;
  lectures: CourseLecture[];
  activities: CourseActivity[];
}

export interface CourseCurriculum {
  courseId: number;
  title: string;
  /** `https://www.udemy.com`, or a Udemy Business subdomain. */
  origin: string;
  slug: string;
  sections: CourseSection[];
}

/**
 * Lecture types whose own asset is a document the student may download.
 *
 * Video and audio lectures are deliberately absent: those are streamed media,
 * and this extension does not download them.
 */
const DOCUMENT_ASSET_TYPES = new Set(['E-Book', 'File', 'Presentation']);

function isAutoCaption(caption: RawCaption): boolean {
  return caption.source === 'auto' || /\[auto\]/i.test(caption.video_label ?? caption.title ?? '');
}

function toCaptions(raw: RawCaption[] | undefined): CourseCaption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((caption) => typeof caption.url === 'string' && caption.url.length > 0)
    .map((caption) => ({
      locale: caption.locale_id || 'und',
      label: caption.video_label || caption.title || caption.locale_id || 'Subtitles',
      auto: isAutoCaption(caption),
      url: caption.url!,
    }));
}

function toResources(raw: RawAsset[] | null | undefined): CourseResource[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((asset) => typeof asset.id === 'number')
    .map((asset) => {
      const isLink = asset.asset_type === 'ExternalLink' || (!asset.filename && !!asset.external_url);
      return {
        assetId: asset.id!,
        title: asset.title || asset.filename || 'Resource',
        filename: asset.filename || undefined,
        assetType: asset.asset_type || 'File',
        kind: isLink ? ('link' as const) : ('file' as const),
        externalUrl: asset.external_url || undefined,
      };
    });
}

/**
 * Turn the flat curriculum listing into sections of lectures.
 *
 * The API returns chapters and their items interleaved in course order, so a
 * lecture belongs to the last chapter seen before it. Items before the first
 * chapter — rare, but the API allows it — get a section of their own rather
 * than being dropped.
 */
export function parseCurriculum(
  items: RawCurriculumItem[],
  course: { courseId: number; title: string; origin: string; slug: string },
): CourseCurriculum {
  const sections: CourseSection[] = [];
  let current: CourseSection | null = null;
  let lectureCounter = 0;

  const ensureSection = (): CourseSection => {
    if (!current) {
      current = { index: 0, title: 'Introduction', lectures: [], activities: [] };
      sections.push(current);
    }
    return current;
  };

  for (const item of items) {
    if (item._class === 'chapter') {
      current = {
        index: item.object_index ?? sections.length + 1,
        title: item.title?.trim() || `Section ${sections.length + 1}`,
        lectures: [],
        activities: [],
      };
      sections.push(current);
      continue;
    }

    if (item._class === 'lecture' && typeof item.id === 'number') {
      lectureCounter += 1;
      const asset = item.asset ?? undefined;
      const assetType = asset?.asset_type ?? 'Video';
      ensureSection().lectures.push({
        id: item.id,
        index: item.object_index ?? lectureCounter,
        title: item.title?.trim() || `Lecture ${lectureCounter}`,
        assetType,
        assetId: asset?.id,
        mainFilename: DOCUMENT_ASSET_TYPES.has(assetType) ? asset?.filename || undefined : undefined,
        durationSeconds:
          typeof asset?.time_estimation === 'number' && asset.time_estimation > 0
            ? asset.time_estimation
            : undefined,
        captions: toCaptions(asset?.captions),
        resources: toResources(item.supplementary_assets),
      });
      continue;
    }

    if (item._class) {
      ensureSection().activities.push({
        kind: item._class,
        index: item.object_index ?? 0,
        title: item.title?.trim() || item._class,
      });
    }
  }

  return { ...course, sections };
}

/** Every lecture, in course order. */
export function allLectures(curriculum: CourseCurriculum): CourseLecture[] {
  return curriculum.sections.flatMap((section) => section.lectures);
}

export interface LocaleSummary {
  locale: string;
  label: string;
  /** Lectures with a track in this locale. */
  lectures: number;
  auto: boolean;
}

/**
 * Which subtitle languages the course has, most widely available first.
 *
 * A locale counts as auto only if every one of its tracks is: one written
 * track is enough for the label to say so.
 */
export function captionLocales(curriculum: CourseCurriculum): LocaleSummary[] {
  const byLocale = new Map<string, LocaleSummary>();
  for (const lecture of allLectures(curriculum)) {
    const seen = new Set<string>();
    for (const caption of lecture.captions) {
      const entry = byLocale.get(caption.locale) ?? {
        locale: caption.locale,
        label: caption.label.replace(/\s*\[auto\]\s*/i, '').trim() || caption.locale,
        lectures: 0,
        auto: true,
      };
      if (!caption.auto) entry.auto = false;
      if (!seen.has(caption.locale)) {
        entry.lectures += 1;
        seen.add(caption.locale);
      }
      byLocale.set(caption.locale, entry);
    }
  }
  return [...byLocale.values()].sort(
    (a, b) => b.lectures - a.lectures || a.locale.localeCompare(b.locale),
  );
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

// Forbidden on Windows, and therefore by chrome.downloads everywhere.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Names chrome.downloads refuses outright, whatever the OS.
const CHROME_REFUSED = /^(desktop\.ini|thumbs\.db)$|\.(lnk|local)$/i;

/**
 * Lengths that keep a full path under Windows' 260-character limit.
 *
 * `Downloads/Udemy/<course>/<NN - section>/<NNN - lecture>/<file>` with these
 * caps is about 230 characters before the user's own Downloads path. The full
 * titles are in `README.md`; the folder names only have to be recognisable.
 */
const MAX = { course: 40, section: 40, lecture: 45, file: 80 } as const;

/**
 * One path segment that every OS — and Chrome's download API, which is stricter
 * than any of them — accepts.
 *
 * Trailing dots and spaces are stripped because Windows silently drops them,
 * which would make the index point at a name that does not exist; a leading
 * dot would hide the file on macOS and Linux.
 */
export function safeSegment(name: string, maxLength = 80, fallback = 'untitled'): string {
  let clean = name
    .normalize('NFC')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.~\s]+/, '');

  if (clean.length > maxLength) clean = clean.slice(0, maxLength);
  clean = clean.replace(/[.\s]+$/, '');

  if (!clean) clean = fallback;
  if (RESERVED.test(clean.split('.')[0])) clean = `_${clean}`;
  if (CHROME_REFUSED.test(clean)) clean = `${clean}_`;
  return clean;
}

/**
 * A file name, shortened without losing its extension.
 *
 * `Very long lecture handout … .pdf` must still end in `.pdf`, or nothing will
 * open it.
 */
export function safeFilename(name: string, maxLength: number = MAX.file, fallback = 'file'): string {
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && name.length - dot <= 10;
  if (!hasExtension) return safeSegment(name, maxLength, fallback);

  const extension = safeSegment(name.slice(dot + 1), 10, '').replace(/\s/g, '');
  const stem = safeSegment(name.slice(0, dot), Math.max(1, maxLength - extension.length - 1), fallback);
  const joined = extension ? `${stem}.${extension}` : stem;
  return CHROME_REFUSED.test(joined) ? `${joined}_` : joined;
}

function pad(value: number, width: number): string {
  return String(Math.max(0, value)).padStart(width, '0');
}

function widthFor(count: number, minimum: number): number {
  return Math.max(minimum, String(Math.max(1, count)).length);
}

/**
 * Hands out names inside one folder without collisions.
 *
 * Case-insensitive, because two resources called `Slides.pdf` and `slides.pdf`
 * are one file on Windows and macOS.
 */
class FolderNames {
  private used = new Set<string>();

  take(name: string): string {
    let candidate = name;
    let n = 2;
    while (this.used.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      candidate =
        dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      n += 1;
    }
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

export type SubtitleFormat = 'vtt' | 'srt' | 'txt';

export interface DownloadOptions {
  /** Locales to keep; `'all'` keeps every track. */
  locales: string[] | 'all';
  /** Empty means no subtitles at all. */
  subtitleFormats: SubtitleFormat[];
  /** Attached files, plus lectures that are themselves a document. */
  resources: boolean;
  /** External links, written to a `links.md` per lecture. */
  links: boolean;
  /** Article lectures, saved as HTML. */
  articles: boolean;
  /**
   * The whole course as one Markdown file, cleaned for reading by a language
   * model, in the first chosen language.
   */
  courseFile: boolean;
}

export const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  locales: 'all',
  subtitleFormats: ['srt', 'vtt'],
  resources: true,
  links: true,
  articles: true,
  courseFile: true,
};

/** Name of the one-file course, at the top of the course folder. */
export const COURSE_FILE = 'Full course transcript.md';

interface PlannedBase {
  /** Relative to the course folder, forward slashes. */
  path: string;
  lectureId: number;
}

export type PlannedFile =
  | (PlannedBase & { kind: 'caption'; url: string; locale: string; format: SubtitleFormat })
  | (PlannedBase & { kind: 'resource'; assetId: number; main: boolean; title: string })
  | (PlannedBase & { kind: 'article'; title: string })
  | (PlannedBase & { kind: 'links'; text: string })
  | (PlannedBase & { kind: 'course-text'; locale: string });

export interface PlannedLecture {
  lecture: CourseLecture;
  sectionIndex: number;
  sectionTitle: string;
  /** Folder of this lecture, relative to the course folder. */
  folder: string;
  files: PlannedFile[];
}

export interface DownloadPlan {
  /** Folder the whole course goes in, relative to the Downloads folder. */
  root: string;
  lectures: PlannedLecture[];
  files: PlannedFile[];
}

function wantsLocale(options: DownloadOptions, locale: string): boolean {
  return options.locales === 'all' || options.locales.includes(locale);
}

/**
 * The one language a single-language output is written in: the most widely
 * available of the chosen ones.
 */
export function primaryLocale(curriculum: CourseCurriculum, options: DownloadOptions): string | null {
  return captionLocales(curriculum).find((entry) => wantsLocale(options, entry.locale))?.locale ?? null;
}

/** Markdown link target that survives spaces and brackets in the path. */
function linkTarget(path: string): string {
  return `<${path.replace(/[<>]/g, '')}>`;
}

function linksMarkdown(lecture: CourseLecture, links: CourseResource[]): string {
  const lines = [`# ${lecture.title} — links`, ''];
  for (const link of links) {
    lines.push(link.externalUrl ? `- [${link.title}](${link.externalUrl})` : `- ${link.title}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Decide every file and where it goes.
 *
 * Nothing is fetched here: resources are planned by asset id, because their
 * download links are signed, short-lived URLs that are only worth asking for
 * at the moment of download.
 */
export function planCourseDownload(
  curriculum: CourseCurriculum,
  options: DownloadOptions,
): DownloadPlan {
  const root = `Udemy/${safeSegment(curriculum.title, MAX.course, `course-${curriculum.courseId}`)}`;
  const sectionWidth = widthFor(curriculum.sections.length, 2);
  const lectureWidth = widthFor(
    Math.max(0, ...allLectures(curriculum).map((lecture) => lecture.index)),
    3,
  );

  const sectionNames = new FolderNames();
  const lectures: PlannedLecture[] = [];

  for (const section of curriculum.sections) {
    const sectionFolder = sectionNames.take(
      `${pad(section.index, sectionWidth)} - ${safeSegment(section.title, MAX.section, 'Section')}`,
    );
    const lectureNames = new FolderNames();

    for (const lecture of section.lectures) {
      const base = `${pad(lecture.index, lectureWidth)} - ${safeSegment(lecture.title, MAX.lecture, 'Lecture')}`;
      const folderName = lectureNames.take(base);
      const folder = `${sectionFolder}/${folderName}`;
      const names = new FolderNames();
      const files: PlannedFile[] = [];

      for (const caption of lecture.captions) {
        if (!wantsLocale(options, caption.locale)) continue;
        const locale = safeSegment(caption.locale, 20, 'und').replace(/\s/g, '_');
        for (const format of options.subtitleFormats) {
          const name = names.take(`${folderName}.${locale}${caption.auto ? '.auto' : ''}.${format}`);
          files.push({
            kind: 'caption',
            path: `${folder}/${name}`,
            lectureId: lecture.id,
            url: caption.url,
            locale: caption.locale,
            format,
          });
        }
      }

      if (options.articles && lecture.assetType === 'Article') {
        files.push({
          kind: 'article',
          path: `${folder}/${names.take(`${folderName}.html`)}`,
          lectureId: lecture.id,
          title: lecture.title,
        });
      }

      if (options.resources && lecture.mainFilename && lecture.assetId !== undefined) {
        files.push({
          kind: 'resource',
          path: `${folder}/${names.take(safeFilename(lecture.mainFilename))}`,
          lectureId: lecture.id,
          assetId: lecture.assetId,
          main: true,
          title: lecture.title,
        });
      }

      if (options.resources) {
        for (const resource of lecture.resources) {
          if (resource.kind !== 'file') continue;
          files.push({
            kind: 'resource',
            path: `${folder}/${names.take(safeFilename(resource.filename ?? resource.title))}`,
            lectureId: lecture.id,
            assetId: resource.assetId,
            main: false,
            title: resource.title,
          });
        }
      }

      const links = lecture.resources.filter((resource) => resource.kind === 'link');
      if (options.links && links.length > 0) {
        files.push({
          kind: 'links',
          path: `${folder}/${names.take('links.md')}`,
          lectureId: lecture.id,
          text: linksMarkdown(lecture, links),
        });
      }

      lectures.push({
        lecture,
        sectionIndex: section.index,
        sectionTitle: section.title,
        folder,
        files,
      });
    }
  }

  const files = lectures.flatMap((entry) => entry.files);
  const locale = options.courseFile ? primaryLocale(curriculum, options) : null;
  if (locale) files.push({ kind: 'course-text', path: COURSE_FILE, lectureId: 0, locale });

  return { root, lectures, files };
}

/** What happened to one planned file. */
export type FileOutcome = { status: 'saved' } | { status: 'failed'; reason: string };

function describeFile(file: PlannedFile): string {
  switch (file.kind) {
    case 'caption':
      return `Subtitles · ${file.locale} · ${file.format.toUpperCase()}`;
    case 'article':
      return 'Article';
    case 'links':
      return 'Links';
    case 'resource':
      return file.main ? 'Lecture document' : `Resource · ${file.title}`;
    case 'course-text':
      return `Whole course · ${file.locale}`;
  }
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return '';
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? ` · ${Math.floor(minutes / 60)} h ${minutes % 60} min` : ` · ${minutes} min`;
}

/**
 * The course's `README.md`: the curriculum, with every downloaded file linked
 * from the lecture it belongs to.
 *
 * Written last, from the outcomes, so a file that failed is marked as such
 * instead of being a dead link nobody can explain.
 */
export function buildCourseIndex(
  curriculum: CourseCurriculum,
  plan: DownloadPlan,
  outcomes: Map<string, FileOutcome>,
  generatedAt = new Date(),
): string {
  const lines: string[] = [
    `# ${curriculum.title}`,
    '',
    `Source: ${curriculum.origin}/course/${curriculum.slug}/`,
    `Downloaded: ${generatedAt.toISOString().slice(0, 10)}`,
    '',
  ];

  const courseFile = plan.files.find((file) => file.kind === 'course-text');
  if (courseFile && outcomes.get(courseFile.path)?.status === 'saved') {
    lines.push(
      `Whole course in one file, for reading or for an AI assistant: [${courseFile.path}](${linkTarget(courseFile.path)})`,
      '',
    );
  }

  const bySection = new Map<number, PlannedLecture[]>();
  for (const entry of plan.lectures) {
    const list = bySection.get(entry.sectionIndex) ?? [];
    list.push(entry);
    bySection.set(entry.sectionIndex, list);
  }

  for (const section of curriculum.sections) {
    lines.push(`## ${section.index}. ${section.title}`, '');

    const items = [
      ...(bySection.get(section.index) ?? []).map((entry) => ({ index: entry.lecture.index, entry })),
      ...section.activities.map((activity) => ({ index: activity.index, activity })),
    ].sort((a, b) => a.index - b.index);

    for (const item of items) {
      if ('activity' in item) {
        lines.push(`- ${item.activity.index}. ${item.activity.title} _(${item.activity.kind}, online only)_`);
        continue;
      }

      const { entry } = item;
      const url = `${curriculum.origin}/course/${curriculum.slug}/learn/lecture/${entry.lecture.id}`;
      lines.push(
        `- **${entry.lecture.index}. ${entry.lecture.title}** — [open on Udemy](${url})${formatDuration(entry.lecture.durationSeconds)}`,
      );

      for (const file of entry.files) {
        const outcome = outcomes.get(file.path);
        const name = file.path.slice(file.path.lastIndexOf('/') + 1);
        if (outcome?.status === 'failed') {
          lines.push(`  - ${describeFile(file)}: ${name} — _not downloaded: ${outcome.reason}_`);
        } else if (outcome?.status === 'saved') {
          lines.push(`  - ${describeFile(file)}: [${name}](${linkTarget(file.path)})`);
        }
      }

      for (const link of entry.lecture.resources.filter((resource) => resource.kind === 'link')) {
        if (link.externalUrl) lines.push(`  - Link: [${link.title}](${link.externalUrl})`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/** The same mapping as the index, for scripts and note apps. */
export function buildCourseManifest(
  curriculum: CourseCurriculum,
  plan: DownloadPlan,
  outcomes: Map<string, FileOutcome>,
): string {
  return JSON.stringify(
    {
      courseId: curriculum.courseId,
      title: curriculum.title,
      url: `${curriculum.origin}/course/${curriculum.slug}/`,
      fullTranscript: plan.files.find((file) => file.kind === 'course-text')?.path ?? null,
      sections: curriculum.sections.map((section) => ({
        index: section.index,
        title: section.title,
        lectures: plan.lectures
          .filter((entry) => entry.sectionIndex === section.index)
          .map((entry) => ({
            id: entry.lecture.id,
            index: entry.lecture.index,
            title: entry.lecture.title,
            type: entry.lecture.assetType,
            folder: entry.folder,
            files: entry.files.map((file) => ({
              kind: file.kind,
              path: file.path,
              ...(file.kind === 'caption' ? { locale: file.locale, format: file.format } : {}),
              ...(outcomes.get(file.path) ?? { status: 'skipped' }),
            })),
            links: entry.lecture.resources
              .filter((resource) => resource.kind === 'link')
              .map((resource) => ({ title: resource.title, url: resource.externalUrl })),
          })),
        activities: section.activities,
      })),
    },
    null,
    2,
  );
}

/**
 * The first usable URL in an asset's `download_urls`.
 *
 * Keyed by asset type (`File`, `E-Book`, `Presentation`…), each a list of
 * `{ label, file }`. The key is not worth trusting — it has varied by asset
 * type over the years — so every list is searched.
 */
export function pickDownloadUrl(downloadUrls: unknown): string | null {
  if (!downloadUrls || typeof downloadUrls !== 'object') return null;
  for (const value of Object.values(downloadUrls as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const file = (entry as { file?: unknown })?.file;
      if (typeof file === 'string' && /^https?:\/\//.test(file)) return file;
    }
  }
  return null;
}

/** Lecture page URL — the identity the library uses for a Udemy lecture. */
export function lectureUrl(curriculum: CourseCurriculum, lectureId: number): string {
  return `${curriculum.origin}/course/${curriculum.slug}/learn/lecture/${lectureId}`;
}

/** An article body as a page that opens on its own. */
export function articleHtml(title: string, body: string): string {
  const escaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escaped}</title>
<style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif}img{max-width:100%}pre{overflow:auto;background:#f4f4f5;padding:.75rem;border-radius:6px}</style>
</head>
<body>
<h1>${escaped}</h1>
${body}
</body>
</html>
`;
}
