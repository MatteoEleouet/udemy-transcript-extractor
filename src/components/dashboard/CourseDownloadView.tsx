import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Download, FolderDown, Loader2, RefreshCw } from 'lucide-react';
import {
  DOWNLOAD_PERMISSIONS,
  findUdemyCourseTabs,
  loadCurriculum,
  runCourseDownload,
  type DownloadProgress,
  type DownloadReport,
  type OutputMode,
  type UdemyTab,
} from '../../lib/course-download';
import {
  allLectures,
  captionLocales,
  planCourseDownload,
  primaryLocale,
  COURSE_FILE,
  DEFAULT_DOWNLOAD_OPTIONS,
  type CourseCurriculum,
  type DownloadOptions,
  type SubtitleFormat,
} from '../../lib/udemy-course';

interface CourseDownloadViewProps {
  /** The tab the popup was opened from, when it was a Udemy course. */
  initialTabId?: number;
  onOpenLibrary: () => void;
}

const FORMAT_LABELS: Record<SubtitleFormat, string> = {
  srt: 'SRT',
  vtt: 'WebVTT',
  txt: 'Clean text, for reading or AI',
};

const card =
  'rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5';
const heading = 'text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500';

/**
 * A whole Udemy course — every subtitle track and every attached resource —
 * saved as folders that mirror the curriculum.
 *
 * Lives in the dashboard rather than the popup: a course is hundreds of files
 * and minutes of work, and the popup would be gone the first time the user
 * clicked anywhere else.
 */
export const CourseDownloadView: React.FC<CourseDownloadViewProps> = ({
  initialTabId,
  onOpenLibrary,
}) => {
  const [tabs, setTabs] = useState<UdemyTab[] | null>(null);
  const [tabId, setTabId] = useState<number | null>(initialTabId ?? null);
  const [curriculum, setCurriculum] = useState<CourseCurriculum | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [options, setOptions] = useState<DownloadOptions>(DEFAULT_DOWNLOAD_OPTIONS);
  const [mode, setMode] = useState<OutputMode>('folder');
  const [importLocale, setImportLocale] = useState<string | null>(null);

  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [report, setReport] = useState<DownloadReport | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refreshTabs = useCallback(async () => {
    const found = await findUdemyCourseTabs();
    setTabs(found);
    setTabId((current) =>
      current !== null && found.some((tab) => tab.tabId === current) ? current : (found[0]?.tabId ?? null),
    );
  }, []);

  useEffect(() => {
    void refreshTabs();
  }, [refreshTabs]);

  useEffect(() => {
    if (tabId === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCurriculum(null);
    setReport(null);

    loadCurriculum(tabId)
      .then((loaded) => {
        if (cancelled) return;
        setCurriculum(loaded);
        // The language most lectures have is the sensible one to read in.
        setImportLocale(captionLocales(loaded)[0]?.locale ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tabId]);

  const locales = useMemo(() => (curriculum ? captionLocales(curriculum) : []), [curriculum]);
  const plan = useMemo(
    () => (curriculum ? planCourseDownload(curriculum, options) : null),
    [curriculum, options],
  );

  const courseFileLanguage = useMemo(() => {
    if (!curriculum) return null;
    const locale = primaryLocale(curriculum, options);
    return locales.find((entry) => entry.locale === locale)?.label ?? null;
  }, [curriculum, options, locales]);

  const counts = useMemo(() => {
    const files = plan?.files ?? [];
    return {
      subtitles: files.filter((f) => f.kind === 'caption').length,
      resources: files.filter((f) => f.kind === 'resource').length,
      articles: files.filter((f) => f.kind === 'article').length,
      links: curriculum
        ? allLectures(curriculum).reduce(
            (sum, lecture) => sum + lecture.resources.filter((r) => r.kind === 'link').length,
            0,
          )
        : 0,
    };
  }, [plan, curriculum]);

  const toggleLocale = (locale: string) => {
    setOptions((current) => {
      const selected = current.locales === 'all' ? locales.map((l) => l.locale) : current.locales;
      const next = selected.includes(locale)
        ? selected.filter((l) => l !== locale)
        : [...selected, locale];
      return { ...current, locales: next.length === locales.length ? 'all' : next };
    });
  };

  const toggleFormat = (format: SubtitleFormat) => {
    setOptions((current) => ({
      ...current,
      subtitleFormats: current.subtitleFormats.includes(format)
        ? current.subtitleFormats.filter((f) => f !== format)
        : [...current.subtitleFormats, format],
    }));
  };

  const start = async () => {
    if (!curriculum || tabId === null) return;

    // Asked here, inside the click: Chrome only shows the prompt for a user
    // gesture, and only people who use this feature should be asked at all.
    let granted = false;
    try {
      granted = await chrome.permissions.request(DOWNLOAD_PERMISSIONS);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (!granted) {
      setError('Saving files needs the downloads permission. Nothing was downloaded.');
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setReport(null);
    setProgress({ done: 0, total: 1, failed: 0 });

    try {
      const result = await runCourseDownload(tabId, curriculum, options, {
        mode,
        importLocale,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setReport(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const running = progress !== null;
  const nothingToDo = !plan || (plan.files.length === 0 && !importLocale);

  return (
    <div className="max-w-3xl">
      <h1 className="text-[22px] font-semibold mb-0.5">Download a course</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
        Every subtitle track and every attached resource of a Udemy course you are enrolled in,
        saved in folders that follow the curriculum. Videos are not downloaded.
      </p>

      {/* Which course. The API is read through the course's own tab, which is
          what carries your Udemy session, so the tab has to stay open. */}
      <section className={`${card} mb-4`}>
        <div className="flex items-center justify-between mb-2">
          <h2 className={heading}>Course</h2>
          <button
            onClick={() => void refreshTabs()}
            disabled={running}
            className="inline-flex items-center gap-1 text-[12px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {tabs === null ? (
          <p className="text-sm text-slate-500">Looking for open Udemy courses…</p>
        ) : tabs.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Open a lecture of the course on udemy.com in another tab, then press Refresh.
          </p>
        ) : (
          <select
            value={tabId ?? ''}
            disabled={running}
            onChange={(event) => setTabId(Number(event.target.value))}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
          >
            {tabs.map((tab) => (
              <option key={tab.tabId} value={tab.tabId}>
                {tab.title}
              </option>
            ))}
          </select>
        )}

        {loading && (
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading the curriculum…
          </p>
        )}

        {curriculum && (
          <div className="mt-4">
            <p className="font-semibold">{curriculum.title}</p>
            <p className="text-[13px] text-slate-500 dark:text-slate-400">
              {curriculum.sections.length} sections · {allLectures(curriculum).length} lectures ·{' '}
              {locales.length} subtitle languages · {counts.links} links
            </p>
          </div>
        )}
      </section>

      {error && (
        <div className="mb-4 flex gap-2 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-200">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {curriculum && plan && (
        <>
          <section className={`${card} mb-4 space-y-5`}>
            <div>
              <h2 className={`${heading} mb-2`}>Subtitles</h2>
              {locales.length === 0 ? (
                <p className="text-sm text-slate-500">This course has no subtitles.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {locales.map((locale) => {
                    const on = options.locales === 'all' || options.locales.includes(locale.locale);
                    return (
                      <button
                        key={locale.locale}
                        disabled={running}
                        onClick={() => toggleLocale(locale.locale)}
                        className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                          on
                            ? 'border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                            : 'border-slate-200 dark:border-slate-700 text-slate-500'
                        }`}
                      >
                        {locale.label}
                        {locale.auto ? ' (auto)' : ''} · {locale.lectures}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-4 text-sm">
                {(Object.keys(FORMAT_LABELS) as SubtitleFormat[]).map((format) => (
                  <label key={format} className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={running}
                      checked={options.subtitleFormats.includes(format)}
                      onChange={() => toggleFormat(format)}
                    />
                    {FORMAT_LABELS[format]}
                  </label>
                ))}
              </div>
              {/* The format to hand a language model: one ordered file beats
                  hundreds of small ones. */}
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={running || locales.length === 0}
                  checked={options.courseFile}
                  onChange={(event) => setOptions({ ...options, courseFile: event.target.checked })}
                />
                <span>
                  The whole course in one file, <code>{COURSE_FILE}</code>
                  {courseFileLanguage ? ` (${courseFileLanguage})` : ''}
                  <span className="block text-[12px] text-slate-500 dark:text-slate-400">
                    Every lecture in order, cleaned into paragraphs, with a contents list. The best
                    thing to give Claude, ChatGPT or NotebookLM.
                  </span>
                </span>
              </label>
            </div>

            <div>
              <h2 className={`${heading} mb-2`}>Resources</h2>
              <div className="space-y-1.5 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={running}
                    checked={options.resources}
                    onChange={(event) => setOptions({ ...options, resources: event.target.checked })}
                  />
                  Attached files — PDFs, slides, source code, documents
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={running}
                    checked={options.articles}
                    onChange={(event) => setOptions({ ...options, articles: event.target.checked })}
                  />
                  Article lectures, as HTML pages
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={running}
                    checked={options.links}
                    onChange={(event) => setOptions({ ...options, links: event.target.checked })}
                  />
                  External links, as a <code>links.md</code> per lecture
                </label>
              </div>
            </div>

            <div>
              <h2 className={`${heading} mb-2`}>Library</h2>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={running || locales.length === 0}
                  checked={importLocale !== null}
                  onChange={(event) =>
                    setImportLocale(event.target.checked ? (locales[0]?.locale ?? null) : null)
                  }
                />
                Also add every lecture's transcript to the library, in
                <select
                  value={importLocale ?? ''}
                  disabled={running || importLocale === null}
                  onChange={(event) => setImportLocale(event.target.value)}
                  className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-0.5 text-sm"
                >
                  {locales.map((locale) => (
                    <option key={locale.locale} value={locale.locale}>
                      {locale.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
                The whole course becomes searchable at once. Lectures you already extracted keep
                their transcript, highlights and notes.
              </p>
            </div>

            <div>
              <h2 className={`${heading} mb-2`}>Layout</h2>
              {/* Flat first: Claude, ChatGPT and NotebookLM take files, never a
                  folder, so sub-folders only get in the way of uploading. */}
              <div className="space-y-1.5 text-sm mb-4">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    className="mt-1"
                    disabled={running}
                    checked={options.layout === 'flat'}
                    onChange={() => setOptions({ ...options, layout: 'flat' })}
                  />
                  <span>
                    Everything in one folder
                    <span className="block text-[12px] text-slate-500 dark:text-slate-400">
                      Each name starts with its lecture number — <code>012 - Lecture - slides.pdf</code>
                      — so you can select them all and drop them into Claude or ChatGPT.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    className="mt-1"
                    disabled={running}
                    checked={options.layout === 'folders'}
                    onChange={() => setOptions({ ...options, layout: 'folders' })}
                  />
                  <span>
                    One folder per section and lecture
                    <span className="block text-[12px] text-slate-500 dark:text-slate-400">
                      Tidier to browse, like the course player.
                    </span>
                  </span>
                </label>
              </div>

              <h2 className={`${heading} mb-2`}>Save as</h2>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    disabled={running}
                    checked={mode === 'folder'}
                    onChange={() => setMode('folder')}
                  />
                  Files in Downloads
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    disabled={running}
                    checked={mode === 'zip'}
                    onChange={() => setMode('zip')}
                  />
                  One ZIP archive
                </label>
              </div>
              <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
                Files stream to disk one by one and suit large courses. A ZIP is assembled in
                memory first. If Chrome asks where to save every file, turn that off in its
                download settings, or use the ZIP.
              </p>
            </div>
          </section>

          <section className={`${card} mb-4`}>
            <p className="text-sm">
              <span className="font-semibold">{plan.files.length + 2} files</span>{' '}
              <span className="text-slate-500 dark:text-slate-400">
                — {counts.subtitles} subtitles, {counts.resources} resources, {counts.articles}{' '}
                articles, plus <code>README.md</code> and <code>course.json</code> indexing them —
                into <code>Downloads/{plan.root}{mode === 'zip' ? '.zip' : '/'}</code>
              </span>
            </p>

            {running ? (
              <div className="mt-4">
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all"
                    style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-[12px] text-slate-500 truncate">
                  {progress.done} / {progress.total}
                  {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
                  {progress.current ? ` · ${progress.current}` : ''}
                </p>
                <button
                  onClick={() => abort.current?.abort()}
                  className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-[13px] hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => void start()}
                disabled={nothingToDo}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 px-4 py-2.5 text-[13px] font-semibold text-white"
              >
                {mode === 'zip' ? <Download className="w-4 h-4" /> : <FolderDown className="w-4 h-4" />}
                Download course
              </button>
            )}
          </section>
        </>
      )}

      {report && (
        <section className={card}>
          <p className="flex items-center gap-2 font-semibold">
            {report.cancelled ? (
              <AlertCircle className="w-4 h-4 text-amber-500" />
            ) : (
              <CheckCircle className="w-4 h-4 text-emerald-500" />
            )}
            {report.cancelled ? 'Cancelled' : 'Done'} — {report.saved} files saved
            {report.failures.length > 0 ? `, ${report.failures.length} failed` : ''}
          </p>
          <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
            In <code>Downloads/{report.root}</code>. Open <code>README.md</code> there for the
            course with every file linked from its lecture.
          </p>
          {report.imported && (
            <p className="mt-2 text-[13px]">
              {report.imported.added} transcripts added to your library
              {report.imported.kept > 0 ? ` (${report.imported.kept} already there, kept)` : ''}.{' '}
              <button onClick={onOpenLibrary} className="text-blue-600 hover:underline">
                Open the library
              </button>
            </p>
          )}
          {report.failures.length > 0 && (
            <ul className="mt-3 max-h-64 overflow-auto space-y-1 text-[12px] text-slate-600 dark:text-slate-300">
              {report.failures.map((failure) => (
                <li key={failure.path}>
                  <code>{failure.path}</code> — {failure.reason}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};
