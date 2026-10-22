<script setup lang="ts">
import { withBase } from 'vitepress';

// The About section's landing page. It is the one page here that is presentation rather
// than documentation: it orients a first-time reader and routes into the repo's own
// markdown, which stays the source of truth for everything it says — see the docs-site
// rule in CLAUDE.md. Nothing below may become the only place a fact is written down.
//
// The screenshot is referenced by path rather than imported: the Pages job copies
// `docs/images` into the built site beside the pages (docs.yml), which is also what makes
// the same picture work in README.md on GitHub.
const shot = withBase('/docs/images/web-app.jpg');

// The web app is the Pages site's root, one level above this section (config.mts `base`).
// Public Data and the log-in box are the start page's two choices, opened directly; the
// links carry `target="_self"` so the docs router doesn't take them for its own pages.
const app = withBase('/../');
const publicData = withBase('/../?tenant=examples&project=examples');
const privateData = withBase('/../?sign-in');

// A string rather than template text, so its line breaks survive Vue's whitespace handling.
const embedSnippet = '<iframe src="viewer/index.html\n    ?checkpoint=my-run.sdata.zarr.zip\n    &embed=1"></iframe>';
</script>

<template>
  <div class="landing">
    <div class="page">
      <header class="masthead">
        <div class="masthead-grid">
          <div>
            <h1>Look at and analyze spatial omics data in your browser</h1>
            <p class="lede">Open a Xenium, Visium or CosMx section and see every cell over the
            tissue image. Find clusters, compare groups and the genes that set them apart, and
            keep what you find as a version of the data, with nothing to install and no code to
            write.</p>
            <div class="actions">
              <a class="action action-primary" :href="app" target="_self">Open the app</a>
              <a class="action" :href="withBase('/docs/guide/README')">Read the guide</a>
            </div>
          </div>

          <div class="ways">
            <a class="way" :href="publicData" target="_self">
              <span class="way-title">Public Data</span>
              <span class="way-text">Public sections, ready to open, with no account. The
              analyses run in your browser, and nothing leaves it.</span>
            </a>
            <a class="way" :href="privateData" target="_self">
              <span class="way-title">Private Data (Cirro)</span>
              <span class="way-text">Your own Cirro projects, read where they are stored, with
              each result saved back to the project for your team.</span>
            </a>
          </div>
        </div>
      </header>

      <section>
        <figure>
          <img class="shot" :src="shot" width="2400" height="1350"
               alt="A Xenium pancreas section open in the web app: every cell drawn over the H&amp;E image and colored by its cellular neighborhood, with the analysis tasks in a drawer on the left and the display settings in a drawer on the right." />
          <figcaption>A Xenium human pancreas section from Public Data, each cell colored by its
          cellular neighborhood over the H&amp;E image. The analyses are in the drawer on the left and the
          display settings in the drawer on the right.
          <a :href="withBase('/docs/guide/public-data')">Explore public data</a> walks through
          it.</figcaption>
        </figure>
      </section>

      <section>
        <p class="eyebrow">How it organizes your data</p>
        <h2>From the instrument to the figure</h2>
        <p class="narrow">The web app sorts a project's data into four stages and shows them as
        a map. An item moves on to the next stage when a pipeline or an analysis makes it.</p>

        <ol class="stages">
          <li class="stage stage-data">
            <span class="stage-name">Images</span>
            <p>Microscopy and histology images on their own, before any cells are found in
            them.</p>
          </li>
          <li class="stage stage-run">
            <span class="stage-name">Instrument runs</span>
            <p>An instrument's raw output as it wrote it: transcripts, its own cell
            segmentation, images and metrics.</p>
          </li>
          <li class="stage stage-obj">
            <span class="stage-name">Spatial data</span>
            <p>Each cell with its position, expression and annotations, with the images and cell
            boundaries, and every version you save on it.</p>
          </li>
          <li class="stage stage-see">
            <span class="stage-name">Figures</span>
            <p>A view kept as a figure, saved inside the version it was made in.</p>
          </li>
        </ol>
        <p class="note"><a :href="withBase('/docs/guide/public-data#four-stages-of-data')">Four
        stages of data</a> has which Cirro datasets and files each stage reads, and what you can
        do at each.</p>

        <div class="cols">
          <div>
            <h3>Analyses with reports</h3>
            <p>Find clusters, compare groups, find marker genes and spatially variable genes,
            measure neighborhood enrichment and find cellular niches, all in your browser. Each
            opens as a report, and each follows scanpy and squidpy and is tested against them.
            <a :href="withBase('/docs/guide/analyze')">Analyze in the browser</a>.</p>
          </div>
          <div>
            <h3>Versions, not copies</h3>
            <p>What you make is saved as a version holding only what changed: a new column of
            labels is kilobytes, beside a store of gigabytes that is not copied. Nothing is ever
            overwritten, so going back is just opening an older version.</p>
          </div>
          <div>
            <h3>Work as a team</h3>
            <p>In Cirro, each version is a dataset in the project, with a note of what was saved
            and by whom. Anyone on the project can open it and save their own version on top.
            <a :href="withBase('/docs/guide/cirro')">Your data in Cirro</a>.</p>
          </div>
          <div>
            <h3>Figures you can publish</h3>
            <p>Keep the tissue as it is shown as a figure, or download it as SVG, PDF or a 300 dpi
            PNG, one or two columns or a slide wide.</p>
          </div>
        </div>
      </section>
    </div>

    <div class="band">
      <div class="page">
        <section>
          <p class="eyebrow">Analysis Workspaces</p>
          <h2 id="analysis-workspaces">When the browser isn't enough</h2>

          <p class="narrow">An Analysis Workspace is the server version of Spatial Data Studio:
          every squidpy and scanpy function through point-and-click forms, curated recipes of
          several steps, and the memory of a whole machine for sections too big for a browser.
          The web app starts one in your Cirro project with the datasets you choose, attached in
          place, so nothing is downloaded and a section too big for a laptop only needs a bigger
          machine.</p>

          <p class="narrow" style="margin-top: 1.05em">You pick a function, fill in a form built
          from that function's own signature, and it runs against the object in memory. The
          analysis adds its columns, embeddings and graphs to the object you already have, and
          appends one entry to the session's history. What the canvas can color by grows as you
          go.</p>

          <figure class="wide">
            <div class="diagram">
              <svg viewBox="0 0 1080 500" role="img"
                   aria-label="Diagram in two rows. The top row: your dataset, read by spatialdata-io, feeds a function you pick from a searchable list whose form comes from the function signature; running it adds columns, embeddings and graphs to the object in memory and appends one history entry; the canvas redraws every cell. The bottom row: saving picks what to keep from a checklist with sizes, writes one .sdata.zarr.zip, and that file reopens either in the app or in a browser with no backend, and can be shared as a link to an exact view.">
                <defs>
                  <marker id="sds-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--rule-strong)" />
                  </marker>
                  <marker id="sds-ah-obj" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--sds-obj)" />
                  </marker>
                </defs>

                <text class="d-lane" x="20" y="18">Running a function</text>

                <rect class="b-data" x="20" y="34" width="180" height="180" rx="7" />
                <text class="d-eyebrow t-data" x="36" y="58">Your data</text>
                <rect class="bar" x="36" y="72" width="148" height="7" rx="3.5" />
                <rect class="bar" x="36" y="86" width="126" height="7" rx="3.5" />
                <rect class="bar-soft" x="36" y="100" width="142" height="7" rx="3.5" />
                <text class="d-arrow" x="36" y="132">a run folder, or a</text>
                <text class="d-arrow" x="36" y="146">.zarr the app saved</text>
                <text class="d-arrow t-data" x="36" y="176">spatialdata-io</text>
                <text class="d-arrow" x="36" y="190">reads it, live log</text>

                <path class="flow" d="M 206 124 L 250 124" marker-end="url(#sds-ah)" />
                <text class="d-arrow" x="228" y="114" text-anchor="middle">you pick</text>

                <rect class="b-run" x="256" y="34" width="280" height="180" rx="7" />
                <text class="d-eyebrow t-run" x="272" y="58">Cellular neighborhoods</text>
                <text class="d-code" x="272" y="80">n_neighbors</text>
                <rect class="bar" x="420" y="72" width="100" height="10" rx="3" />
                <text class="d-code" x="272" y="100">n_clusters</text>
                <rect class="bar" x="420" y="92" width="100" height="10" rx="3" />
                <text class="d-code" x="272" y="120">key_added</text>
                <rect class="bar-soft" x="420" y="112" width="100" height="10" rx="3" />
                <line class="stroke" x1="272" y1="136" x2="520" y2="136" />
                <text class="d-arrow" x="272" y="156">the form is the function's own signature</text>
                <text class="d-arrow t-run" x="272" y="176">citation</text>
                <text class="d-arrow" x="322" y="176">·</text>
                <text class="d-arrow t-run" x="334" y="176">documentation</text>
                <text class="d-arrow" x="272" y="196">every function says where it came from</text>

                <path class="flow" d="M 542 124 L 586 124" marker-end="url(#sds-ah)" />
                <text class="d-arrow" x="564" y="114" text-anchor="middle">runs</text>

                <rect class="b-obj" x="592" y="34" width="230" height="180" rx="7" />
                <text class="d-eyebrow t-obj" x="608" y="58">The object, in place</text>
                <text class="d-code" x="608" y="80">obs["neighborhood"]</text>
                <text class="d-code" x="608" y="100">obsm["X_umap"]</text>
                <text class="d-code" x="608" y="120">obsp["spatial"]</text>
                <line class="stroke" x1="608" y1="136" x2="806" y2="136" />
                <text class="d-arrow" x="608" y="156">history += one entry</text>
                <text class="d-arrow" x="608" y="176">no undo, no copies:</text>
                <text class="d-arrow" x="608" y="190">the log is the record</text>

                <path class="flow" d="M 828 124 L 872 124" marker-end="url(#sds-ah)" />
                <text class="d-arrow" x="850" y="114" text-anchor="middle">draws</text>

                <rect class="b-see" x="878" y="34" width="182" height="180" rx="7" />
                <text class="d-eyebrow t-see" x="894" y="58">The canvas</text>
                <rect class="bar-soft" x="894" y="70" width="150" height="96" rx="4" />
                <g>
                  <circle cx="914" cy="150" r="3" fill="var(--sds-see)" />
                  <circle cx="932" cy="140" r="3" fill="var(--sds-see)" />
                  <circle cx="950" cy="146" r="3" fill="var(--sds-obj)" />
                  <circle cx="968" cy="128" r="3" fill="var(--sds-obj)" />
                  <circle cx="986" cy="136" r="3" fill="var(--sds-data)" />
                  <circle cx="1004" cy="118" r="3" fill="var(--sds-data)" />
                  <circle cx="1022" cy="130" r="3" fill="var(--sds-run)" />
                  <circle cx="924" cy="122" r="3" fill="var(--sds-obj)" />
                  <circle cx="960" cy="108" r="3" fill="var(--sds-run)" />
                  <circle cx="996" cy="98" r="3" fill="var(--sds-see)" />
                  <circle cx="942" cy="92" r="3" fill="var(--sds-data)" />
                  <circle cx="1014" cy="86" r="3" fill="var(--sds-obj)" />
                </g>
                <text class="d-arrow" x="894" y="188">every cell, over the image</text>
                <text class="d-arrow" x="894" y="202">color by any column or gene</text>

                <path class="flow-dash s-obj" d="M 707 220 L 707 268" marker-end="url(#sds-ah-obj)" />
                <text class="d-arrow t-obj" x="720" y="248">what you keep is chosen from what is there</text>

                <text class="d-lane" x="20" y="268">Saving what you did</text>

                <rect class="b-data" x="20" y="284" width="180" height="180" rx="7" />
                <text class="d-eyebrow t-data" x="36" y="308">What to keep</text>
                <rect class="stroke" x="36" y="320" width="10" height="10" rx="2" />
                <text class="d-arrow" x="54" y="329">image · 2 levels</text>
                <rect class="stroke" x="36" y="340" width="10" height="10" rx="2" />
                <text class="d-arrow" x="54" y="349">cells · annotations</text>
                <rect class="stroke" x="36" y="360" width="10" height="10" rx="2" />
                <text class="d-arrow" x="54" y="369">embeddings</text>
                <rect class="b-plain" x="36" y="380" width="10" height="10" rx="2" />
                <text class="d-arrow" x="54" y="389">expression · 1.1 GB</text>
                <text class="d-arrow" x="36" y="418">each part priced,</text>
                <text class="d-arrow" x="36" y="432">each one optional</text>

                <path class="flow" d="M 206 374 L 250 374" marker-end="url(#sds-ah)" />
                <text class="d-arrow" x="228" y="364" text-anchor="middle">writes</text>

                <rect class="b-run" x="256" y="284" width="280" height="180" rx="7" />
                <text class="d-eyebrow t-run" x="272" y="308">One file</text>
                <text class="d-code" x="272" y="332">ovary-neighborhoods.sdata.zarr.zip</text>
                <line class="stroke" x1="272" y1="348" x2="520" y2="348" />
                <text class="d-arrow" x="272" y="368">the cells, the image pyramid, the shapes,</text>
                <text class="d-arrow" x="272" y="386">the figures you drew, the display settings,</text>
                <text class="d-arrow" x="272" y="404">and the history that produced all of it</text>
                <text class="d-arrow t-run" x="272" y="432">read by HTTP range requests</text>

                <path class="flow" d="M 542 374 L 586 374" marker-end="url(#sds-ah)" />
                <text class="d-arrow" x="564" y="364" text-anchor="middle">opens</text>

                <rect class="b-obj" x="592" y="284" width="230" height="180" rx="7" />
                <text class="d-eyebrow t-obj" x="608" y="308">Two ways back in</text>
                <text class="d-arrow" x="608" y="332">in the app — history intact,</text>
                <text class="d-arrow" x="608" y="346">and you can keep going</text>
                <line class="stroke" x1="608" y1="362" x2="806" y2="362" />
                <text class="d-arrow" x="608" y="384">in a browser, from a URL,</text>
                <text class="d-arrow" x="608" y="398">with no backend at all</text>
                <text class="d-arrow t-obj" x="608" y="428">streams what the view needs</text>

                <path class="flow" d="M 828 374 L 872 374" marker-end="url(#sds-ah)" />
                <text class="d-arrow" x="850" y="364" text-anchor="middle">share</text>

                <rect class="b-see" x="878" y="284" width="182" height="180" rx="7" />
                <text class="d-eyebrow t-see" x="894" y="308">A link to a view</text>
                <rect class="bar" x="894" y="322" width="150" height="9" rx="4.5" />
                <rect class="bar-soft" x="894" y="338" width="122" height="9" rx="4.5" />
                <text class="d-arrow" x="894" y="372">only what you changed</text>
                <text class="d-arrow" x="894" y="386">travels, so it stays short</text>
                <text class="d-arrow" x="894" y="414">a colleague lands on</text>
                <text class="d-arrow" x="894" y="428">your view, not the saved one</text>
              </svg>
            </div>
            <figcaption><strong>One function, then the file it all ends up in.</strong> The top row
            is the loop you spend the day in; the bottom row is what leaves the machine. The
            checkpoint is one file rather than a folder because that is what a browser can read a
            few kilobytes out of — opening a 438 MB checkpoint and coloring by a gene costs under a
            megabyte. <a :href="withBase('/docs/CHECKPOINT_FORMAT')">The checkpoint format</a> has
            the layout; <a :href="withBase('/DESIGN')">DESIGN.md</a> has the reasoning.</figcaption>
          </figure>

          <p class="narrow" style="margin-top: 38px">An Analysis Workspace is <em class="emph">one
          running app</em>, and colleagues can join it once you share it. Whoever opens a session
          holds its edit lock; everyone else watches, and each analysis appears on their screens
          as it finishes rather than on a reload. What you are looking at stays yours — your gene,
          your channels, your corner of the section — while someone else drives.</p>

          <figure class="wide" style="margin-top: 38px">
            <div class="diagram">
              <svg viewBox="0 0 1080 700" role="img"
                   aria-label="Diagram of a lab sharing one Cirro project. The project holds read-only datasets and a separate area of published results, and everyone signs in as themselves. One Spatial Data Studio workspace runs inside the project, reading the datasets but never writing them, and holds two independent sessions. Three people's browsers connect to that one workspace: one holds a session's edit lock, one watches the same session live, and one works in their own session. The workspace publishes a finished checkpoint back into the project, which a fourth person opens in a plain browser with no app running.">
                <defs>
                  <marker id="sds-ch" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--sds-run)" />
                  </marker>
                  <marker id="sds-ph" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--sds-data)" />
                  </marker>
                  <marker id="sds-sh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--sds-see)" />
                  </marker>
                </defs>

                <rect class="b-run" x="60" y="20" width="960" height="180" rx="9" />
                <text class="d-title" x="86" y="50">Cirro project · one lab's data</text>

                <g transform="translate(944, 36)">
                  <rect x="0" y="8" width="18" height="14" rx="2.5" fill="none" stroke="var(--sds-run)" stroke-width="1.4" />
                  <path d="M 3.5 8 V 5 a 5.5 5.5 0 0 1 11 0 V 8" fill="none" stroke="var(--sds-run)" stroke-width="1.4" />
                  <circle cx="9" cy="15" r="1.8" fill="var(--sds-run)" />
                </g>
                <text class="d-arrow t-run" x="934" y="74" text-anchor="end">everyone signs in as themselves</text>

                <rect class="stroke" x="86" y="82" width="430" height="100" rx="6" />
                <text class="d-sub" x="102" y="102">Datasets · read only</text>
                <rect class="bar-soft" x="102" y="112" width="398" height="18" rx="4" />
                <rect class="bar" x="112" y="118" width="128" height="6" rx="3" />
                <text class="d-arrow" x="490" y="125" text-anchor="end">Xenium · 412,000 cells · 34 GB</text>
                <rect class="bar-soft" x="102" y="136" width="398" height="18" rx="4" />
                <rect class="bar" x="112" y="142" width="96" height="6" rx="3" />
                <text class="d-arrow" x="490" y="149" text-anchor="end">Visium HD · 8 sections</text>
                <rect class="bar-soft" x="102" y="160" width="398" height="18" rx="4" />
                <rect class="bar" x="112" y="166" width="146" height="6" rx="3" />
                <text class="d-arrow" x="490" y="173" text-anchor="end">references · annotations</text>

                <rect class="stroke" x="546" y="82" width="430" height="100" rx="6" stroke-dasharray="4 3.5" />
                <text class="d-sub" x="562" y="102">Published results</text>
                <rect class="bar-soft" x="562" y="112" width="398" height="18" rx="4" />
                <rect class="bar" x="572" y="118" width="104" height="6" rx="3" />
                <text class="d-arrow" x="950" y="125" text-anchor="end">ovary-neighborhoods · v3</text>
                <text class="d-arrow" x="562" y="150">the checkpoints, and the viewer itself, so the</text>
                <text class="d-arrow" x="562" y="166">dataset opens in a browser with nothing running</text>

                <path class="flow s-run" d="M 160 320 L 160 204" marker-end="url(#sds-ch)" />
                <text class="d-arrow t-run" x="150" y="248" text-anchor="end">reads the datasets</text>
                <text class="d-arrow" x="150" y="264" text-anchor="end">never writes them</text>

                <path class="flow-dash s-data" d="M 640 320 L 640 204" marker-end="url(#sds-ph)" />
                <text class="d-arrow t-data" x="654" y="248">publishes a checkpoint,</text>
                <text class="d-arrow t-data" x="654" y="264">only when you ask</text>

                <path class="flow-dash s-see" d="M 920 204 L 920 540" marker-end="url(#sds-sh)" />
                <text class="d-arrow t-see" x="934" y="300">anyone with access</text>
                <text class="d-arrow t-see" x="934" y="316">to the project</text>

                <rect class="b-plain" x="60" y="326" width="700" height="168" rx="9" />
                <text class="d-title" x="86" y="356">Spatial Data Studio · one workspace in the project</text>
                <text class="d-sub" x="86" y="374">public.ecr.aws/cirrobio/spatial-data-studio:v1</text>
                <line class="stroke" x1="86" y1="388" x2="734" y2="388" />

                <rect class="b-obj" x="86" y="402" width="260" height="72" rx="6" />
                <text class="d-eyebrow t-obj" x="102" y="422">Session · ovary-01</text>
                <text class="d-arrow" x="102" y="442">edit lock: Priya</text>
                <text class="d-arrow" x="102" y="460">Marco is watching</text>

                <rect class="b-obj" x="364" y="402" width="260" height="72" rx="6" />
                <text class="d-eyebrow t-obj" x="380" y="422">Session · colon-04</text>
                <text class="d-arrow" x="380" y="442">edit lock: Ada</text>
                <text class="d-arrow" x="380" y="460">independent of the other</text>

                <text class="d-arrow" x="734" y="430" text-anchor="end">the workspace's</text>
                <text class="d-arrow" x="734" y="446" text-anchor="end">CPU and RAM,</text>
                <text class="d-arrow" x="734" y="462" text-anchor="end">not yours</text>

                <path class="flow s-run" d="M 130 540 L 130 500" marker-end="url(#sds-ch)" />
                <path class="flow s-run" d="M 370 540 L 370 500" marker-end="url(#sds-ch)" />
                <path class="flow s-run" d="M 610 540 L 610 500" marker-end="url(#sds-ch)" />
                <text class="d-arrow t-run" x="386" y="524">one URL, three browsers</text>

                <rect class="b-plain" x="20" y="546" width="220" height="120" rx="7" />
                <text class="d-title" x="40" y="574">Priya</text>
                <text class="d-sub" x="40" y="592">holds the lock</text>
                <rect class="bar" x="40" y="606" width="96" height="7" rx="3.5" />
                <rect class="bar-soft" x="40" y="620" width="72" height="7" rx="3.5" />
                <text class="d-arrow" x="40" y="648">runs the clustering</text>

                <rect class="b-plain" x="260" y="546" width="220" height="120" rx="7" />
                <text class="d-title" x="280" y="574">Marco</text>
                <text class="d-sub" x="280" y="592">same session</text>
                <rect class="bar" x="280" y="606" width="88" height="7" rx="3.5" />
                <rect class="bar-soft" x="280" y="620" width="104" height="7" rx="3.5" />
                <text class="d-arrow" x="280" y="648">sees each step land;</text>
                <text class="d-arrow" x="280" y="662">his own gene, his own zoom</text>

                <rect class="b-plain" x="500" y="546" width="220" height="120" rx="7" />
                <text class="d-title" x="520" y="574">Ada</text>
                <text class="d-sub" x="520" y="592">her own session</text>
                <rect class="bar" x="520" y="606" width="80" height="7" rx="3.5" />
                <rect class="bar-soft" x="520" y="620" width="96" height="7" rx="3.5" />
                <text class="d-arrow" x="520" y="648">a different dataset,</text>
                <text class="d-arrow" x="520" y="662">the same workspace</text>

                <rect class="b-see" x="810" y="546" width="220" height="120" rx="7" />
                <text class="d-title" x="830" y="574">Jun</text>
                <text class="d-sub" x="830" y="592">no app running</text>
                <rect class="bar" x="830" y="606" width="92" height="7" rx="3.5" />
                <rect class="bar-soft" x="830" y="620" width="68" height="7" rx="3.5" />
                <text class="d-arrow" x="830" y="648">opens the published</text>
                <text class="d-arrow" x="830" y="662">dataset in a browser</text>
              </svg>
            </div>
            <figcaption><strong>One project, one workspace, several people.</strong> The solid
            arrows are what the app does on its own, and they only read. The dashed ones are yours
            to take: publishing a finished checkpoint into the project, and someone else opening
            it. What each person's browser can see is what their own Cirro account can see —
            there is no shared account and no credential on the server.</figcaption>
          </figure>

          <div class="cards">
            <div class="card">
              <div class="head">
                <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="2" y="8" width="16" height="11" rx="2.2" fill="none" stroke="var(--sds-run)" stroke-width="1.5" />
                  <path d="M 5.5 8 V 5.5 a 4.5 4.5 0 0 1 9 0 V 8" fill="none" stroke="var(--sds-run)" stroke-width="1.5" />
                </svg>
                <h3>Sign in as yourself</h3>
              </div>
              <p>Sign-in is per browser, through Cirro's device-code flow: you open a link, sign in
              as you normally would, and the app never sees a password. The server holds no Cirro
              credential and needs no Cirro configuration, so several people share one running app
              without sharing an account.</p>
            </div>

            <div class="card">
              <div class="head">
                <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M 10 16 V 4 M 5.5 8.5 L 10 4 L 14.5 8.5" fill="none" stroke="var(--sds-data)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M 3 17 h 14" stroke="var(--sds-data)" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                <h3>Publishing is the one write</h3>
              </div>
              <p>Saved checkpoints upload as a new dataset alongside the data rather than on top of
              it. The upload carries the viewer itself and an index of what is in it, so the
              resulting dataset opens as a browsable collection for anyone with access — no app,
              no install, no download.</p>
            </div>

            <div class="card">
              <div class="head">
                <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="7.5" cy="7.5" r="3" fill="none" stroke="var(--sds-see)" stroke-width="1.5" />
                  <circle cx="13.5" cy="12.5" r="3" fill="none" stroke="var(--sds-see)" stroke-width="1.5" />
                  <path d="M 3 17 c 0 -2.6 2 -4 4.5 -4" fill="none" stroke="var(--sds-see)" stroke-width="1.5" stroke-linecap="round" />
                  <path d="M 9 17 h 8" fill="none" stroke="var(--sds-see)" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                <h3>Two people, one session</h3>
              </div>
              <p>The padlock next to a session name says who holds it and who is on it, and names
              everyone in the room. Take an unlocked session, hand yours over, or rename yourself
              from the two-word name you arrived with. Watching costs nothing: display settings are
              per-browser and never enter the session.</p>
            </div>
          </div>

          <p class="note">An Analysis Workspace also runs on your own computer, from one Docker
          command: <a :href="withBase('/docs/guide/docker')">Run it with Docker</a>, which also
          connects an AI assistant to it.
          <a :href="withBase('/docs/guide/analysis-workspaces')">Analysis Workspaces</a> has
          starting one, sharing it and publishing from it;
          <a :href="withBase('/DESIGN')">DESIGN.md</a> §15 has the auth and credential scoping.</p>
        </section>
      </div>
    </div>

    <div class="page">
      <section>
        <p class="eyebrow">Advanced</p>
        <h2>The viewer on its own</h2>

        <div class="split">
          <div>
            <p>A saved checkpoint opens in any browser with nothing running behind it. The viewer
            reads only what the current view needs, so opening a 438 MB checkpoint and coloring
            by a gene costs under a megabyte.</p>
            <p>Copy a link to the exact view you are looking at, put a folder of checkpoints on
            any web server that answers range requests, or show the viewer in a frame on your
            own page or dashboard.</p>
            <p><a :href="withBase('/docs/guide/viewer')">Share and embed the viewer</a> ·
            <a :href="withBase('/demo/')">Live demos</a></p>
          </div>

          <div>
            <div class="standalone">
              <div class="cmds">
                <code class="cmd">{{ embedSnippet }}</code>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <span>Spatial Data Studio</span>
        <a href="https://github.com/CirroBio/spatial-data-studio">github.com/CirroBio/spatial-data-studio</a>
        <a :href="withBase('/LICENSE')">Cirro Bio Source Available License</a>
        <span>Interactive analysis and visualization for spatial omics data.</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Colors come from VitePress's own theme variables wherever one exists, so the page
   follows the site's light/dark toggle without a second switch. Only the four
   categorical hues the diagrams are built from are defined here, and only those need a
   dark variant. */
.landing {
  --paper: var(--vp-c-bg);
  --surface: var(--vp-c-bg);
  --surface-sunk: var(--vp-c-bg-soft);
  --ink: var(--vp-c-text-1);
  --ink-2: var(--vp-c-text-2);
  --ink-3: var(--vp-c-text-3);
  --rule: var(--vp-c-divider);
  --rule-strong: #9bb0b8;

  /* The Cirro accent and the two status hues from frontend/src/index.css, plus the
     vermillion of the viewer's own categorical palette for the fourth. */
  --sds-data: #d55e00;
  --sds-run: #0e7ca0;
  --sds-obj: #894073;
  --sds-see: #2e7d55;

  --tint-data: #fdefe4;
  --tint-run: #d7e8ef;
  --tint-obj: #f5eaf1;
  --tint-see: #e6f1ea;

  --bar: #cbd8dd;
  --bar-soft: #e2eaee;

  --accent-ink: var(--vp-c-brand-1);

  --shadow: 0 1px 2px rgba(5, 11, 38, .06), 0 8px 24px -16px rgba(5, 11, 38, .34);

  background: var(--paper);
  color: var(--ink);
  font-size: 17px;
  line-height: 1.62;
}

.dark .landing {
  --rule-strong: #35607c;

  --sds-data: #e69f00;
  --sds-run: #24bfd3;
  --sds-obj: #c07aa8;
  --sds-see: #4b8f6d;

  --tint-data: #2e1f10;
  --tint-run: #123a4d;
  --tint-obj: #2b1a27;
  --tint-see: #12301f;

  --bar: #23465e;
  --bar-soft: #16283f;

  --shadow: 0 1px 2px rgba(0, 0, 0, .45), 0 8px 24px -16px rgba(0, 0, 0, .75);
}

.landing * { box-sizing: border-box; }

.page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 28px;
}

.narrow { max-width: 65ch; }

.eyebrow {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin: 0 0 14px;
}

.landing h1 {
  font-weight: 700;
  font-size: clamp(34px, 5.2vw, 54px);
  line-height: 1.05;
  letter-spacing: -.028em;
  margin: 0 0 18px;
  text-wrap: balance;
}

.landing h2 {
  font-weight: 700;
  font-size: clamp(25px, 3.4vw, 34px);
  line-height: 1.14;
  letter-spacing: -.02em;
  margin: 0 0 14px;
  text-wrap: balance;
}

.landing h3 {
  font-weight: 600;
  font-size: 17px;
  letter-spacing: -.005em;
  margin: 0 0 6px;
}

.landing p { margin: 0 0 1.05em; }
.landing p:last-child { margin-bottom: 0; }

.landing a {
  color: var(--accent-ink);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.landing a:hover { color: var(--sds-run); }

.landing a:focus-visible {
  outline: 2px solid var(--sds-run);
  outline-offset: 3px;
  border-radius: 3px;
}

.lede {
  font-size: clamp(18px, 2.1vw, 21px);
  line-height: 1.52;
  color: var(--ink-2);
  max-width: 62ch;
}

em.emph { font-style: normal; font-weight: 600; color: var(--ink); }

.landing code {
  font-family: var(--vp-font-family-mono);
  font-size: .86em;
  background: var(--surface-sunk);
  border-radius: 4px;
  padding: .1em .34em;
}

/* masthead */

.masthead { padding: 24px 0 44px; }

.masthead-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 48px 56px;
  align-items: start;
}

@media (max-width: 900px) {
  .masthead-grid { grid-template-columns: 1fr; gap: 34px; }
}

/* the two calls to action, and the start page's two ways in */

.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 26px; }

.landing a.action {
  display: inline-block;
  padding: 10px 20px;
  border: 1px solid var(--rule-strong);
  border-radius: 8px;
  font-weight: 600;
  font-size: 15.5px;
  text-decoration: none;
  color: var(--ink);
  background: var(--surface);
}

.landing a.action:hover { border-color: var(--sds-run); color: var(--ink); }

/* VitePress's own brand-button colors, so it matches the site's buttons in both themes. */
.landing a.action-primary {
  background: var(--vp-button-brand-bg);
  border-color: var(--vp-button-brand-border);
  color: var(--vp-button-brand-text);
}

.landing a.action-primary:hover {
  background: var(--vp-button-brand-hover-bg);
  border-color: var(--vp-button-brand-hover-border);
  color: var(--vp-button-brand-hover-text);
}

.ways { display: grid; gap: 14px; }

.landing a.way {
  display: block;
  padding: 18px 20px;
  border: 1px solid var(--rule);
  border-radius: 9px;
  background: var(--surface);
  box-shadow: var(--shadow);
  text-decoration: none;
  color: var(--ink);
}

.landing a.way:hover { border-color: var(--sds-run); color: var(--ink); }

.way-title { display: block; font-weight: 700; font-size: 18px; margin-bottom: 4px; }
.way-text { display: block; font-size: 15px; line-height: 1.5; color: var(--ink-2); }

.standalone {
  border: 1px solid var(--rule);
  border-radius: 9px;
  background: var(--surface);
  overflow: hidden;
}

.cmds { display: flex; flex-direction: column; }

.cmd {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.55;
  padding: 11px 16px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--ink);
  background: none;
  border-radius: 0;
  border-top: 1px solid var(--rule);
}

.cmd:first-child { border-top: 0; }


/* sections */

.landing section { padding: 56px 0; border-top: 1px solid var(--rule); }

.band {
  background: var(--vp-c-bg-alt);
  border-top: 1px solid var(--rule-strong);
  margin-top: 56px;
}

.band section { border-top: 0; }

/* shots and figures */

.landing figure { margin: 0; }

.landing figcaption {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink-2);
  margin-top: 14px;
  max-width: 82ch;
}

.shot {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--rule-strong);
  border-radius: 10px;
  box-shadow: var(--shadow);
  background: var(--surface);
}

.diagram {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 10px;
  padding: 20px 18px 14px;
  overflow-x: auto;
}

.diagram svg {
  display: block;
  width: 100%;
  min-width: 760px;
  height: auto;
  color: var(--ink);
}

.d-lane { font-family: var(--vp-font-family-mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; fill: var(--ink-3); }
.d-eyebrow { font-family: var(--vp-font-family-mono); font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase; }
.d-code { font-family: var(--vp-font-family-mono); font-size: 11px; fill: var(--ink-2); }
.d-arrow { font-family: var(--vp-font-family-mono); font-size: 10px; fill: var(--ink-3); }
.d-title { font-size: 13px; font-weight: 600; fill: var(--ink); }
.d-sub { font-family: var(--vp-font-family-mono); font-size: 9.5px; letter-spacing: .08em; fill: var(--ink-3); }

.stroke { stroke: var(--rule-strong); fill: none; }
.bar { fill: var(--bar); }
.bar-soft { fill: var(--bar-soft); }
.flow { stroke: var(--rule-strong); stroke-width: 1.25; fill: none; }
.flow-dash { stroke: var(--rule-strong); stroke-width: 1.25; fill: none; stroke-dasharray: 4 3.5; }

.b-data { fill: var(--tint-data); stroke: var(--sds-data); stroke-width: 1.15; }
.b-run { fill: var(--tint-run); stroke: var(--sds-run); stroke-width: 1.15; }
.b-obj { fill: var(--tint-obj); stroke: var(--sds-obj); stroke-width: 1.15; }
.b-see { fill: var(--tint-see); stroke: var(--sds-see); stroke-width: 1.15; }
.b-plain { fill: var(--surface); stroke: var(--rule-strong); stroke-width: 1.15; }

.t-data { fill: var(--sds-data); }
.t-run { fill: var(--sds-run); }
.t-obj { fill: var(--sds-obj); }
.t-see { fill: var(--sds-see); }

.s-run { stroke: var(--sds-run); }
.s-data { stroke: var(--sds-data); }
.s-see { stroke: var(--sds-see); }

.wide { margin-top: 34px; }

/* the four stages, in the map's order */

.stages {
  list-style: none;
  margin: 30px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 14px;
}

.stage {
  margin: 0;
  padding: 16px 18px;
  border-radius: 9px;
  border-top: 3px solid;
  background: var(--surface-sunk);
}

.stage-data { border-color: var(--sds-data); }
.stage-run { border-color: var(--sds-run); }
.stage-obj { border-color: var(--sds-obj); }
.stage-see { border-color: var(--sds-see); }

.stage-name {
  display: block;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  letter-spacing: .1em;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.stage-data .stage-name { color: var(--sds-data); }
.stage-run .stage-name { color: var(--sds-run); }
.stage-obj .stage-name { color: var(--sds-obj); }
.stage-see .stage-name { color: var(--sds-see); }

.stage p { font-size: 14.5px; line-height: 1.5; color: var(--ink-2); }

/* prose columns */

.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 30px 44px;
  margin-top: 34px;
}

.cols h3 {
  font-size: 15px;
  font-weight: 600;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 10px;
}

.cols p { font-size: 15.5px; line-height: 1.55; color: var(--ink-2); }

.split {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  gap: 30px 40px;
  margin-top: 30px;
  align-items: start;
}

.split h3 { margin-bottom: 10px; }
.split p { font-size: 15.5px; color: var(--ink-2); margin-bottom: 14px; }

.note {
  font-size: 14px;
  line-height: 1.58;
  color: var(--ink-2);
  border-left: 2px solid var(--rule-strong);
  padding-left: 16px;
  margin-top: 26px;
  max-width: 70ch;
}

.split .note { margin-top: 18px; }
.stages + .note,
.cards + .note { margin-top: 26px; }

/* the three Cirro cards */

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: 18px;
  margin-top: 32px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 9px;
  padding: 18px 20px;
}

.card .head { display: flex; align-items: center; gap: 9px; margin-bottom: 9px; }

.card h3 {
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  letter-spacing: .09em;
  text-transform: uppercase;
  margin: 0;
  color: var(--ink);
}

.card p { font-size: 15px; line-height: 1.55; color: var(--ink-2); }

.landing footer {
  border-top: 1px solid var(--rule-strong);
  padding: 32px 0 54px;
  font-size: 14px;
  color: var(--ink-3);
  display: flex;
  flex-wrap: wrap;
  gap: 8px 26px;
  align-items: baseline;
}
</style>
