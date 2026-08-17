#!/usr/bin/env nextflow

nextflow.enable.dsl = 2

// Batch Xenium analysis: read each raw bundle named by --input, run the standard
// Xenium recipe chain over it, and publish one deployable folder that renders every
// resulting checkpoint plus a MultiQC report comparing the samples.
//
// The analysis is not defined here — it is three bundled recipes, run back to back in
// one session by `backend/cli.py` (which takes --recipe more than once). Dependencies
// are installed at runtime with uv, as in ../main.nf; see README.md.

process XENIUM_ANALYSIS {
    tag "${sample}"
    container 'ghcr.io/astral-sh/uv:python3.11-bookworm'

    // The checkpoints land straight in the viewer folder PUBLISH_VIEWER fills in, so
    // each one is copied out of the work dir once rather than published twice.
    publishDir "${params.outdir}/viewer", mode: 'copy', pattern: '*.zarr.zip'
    publishDir params.outdir, mode: 'copy', pattern: 'plots/**',
               saveAs: { f -> "plots/${sample}/" + f.toString().tokenize('/').drop(1).join('/') }

    input:
    tuple val(sample), path(xenium_dir)
    // The whole backend/ tree (cli.py + app/, which carries the recipes) is needed at
    // runtime; stage it so cli.py and its `app` package resolve on any executor.
    path backend
    path metrics_script

    output:
    // One .zarr.zip, or two when --lowres_copy is set (the second is `.lowres.`). Named
    // after --name rather than a bare *.zarr.zip, which a Xenium bundle also contains.
    tuple val(sample), path("${sample}.sdata*.zarr.zip"), emit: checkpoint
    path '*_mqc.json', emit: metrics
    path 'plots/**',   emit: plots

    script:
    // One mapping drives all three recipes: each fills only the $param names it
    // declares. `cell_type_key` is deliberately the cluster column, so the
    // neighborhoods are built from the Leiden calls made a step earlier.
    def recipe_params = groovy.json.JsonOutput.toJson([
        min_counts      : params.min_counts,
        min_cells       : params.min_cells,
        cluster_key     : params.cluster_key,
        resolution      : params.resolution,
        method          : params.marker_method,
        n_genes         : params.n_marker_genes,
        cell_type_key   : params.cluster_key,
        n_neighborhoods : params.n_neighborhoods,
        neighborhood_key: params.neighborhood_key,
    ])
    def recipes = [
        '01_xenium_preprocess_qc.json',   // QC -> filter -> normalize -> log1p -> PCA/neighbors/UMAP
        '02_leiden_cluster_markers.json', // Leiden clusters + ranked marker genes (+ dotplot)
        '04_neighborhood_analysis.json',  // cellular neighborhoods over those clusters (+ plot)
    ]
    def recipe_args = recipes
        .collect { recipe -> "--recipe ${backend}/app/recipes/${recipe}" }
        .join(' \\\n        ')
    def reader_params_arg = params.reader_params ? "--reader-params '${params.reader_params}'" : ''
    def lowres_arg = params.lowres_copy ? '--lowres-copy' : ''
    // The uv base image is bookworm-slim; Xenium bundles are image-backed, so the OS
    // libraries the imaging path needs are installed by default (see README). Two
    // statements rather than an `&&` chain: `set -e` does not abort on the left operand
    // of `&&`, so a chain would let a failed install fall through to a confusing
    // ImportError several minutes later instead of stopping here.
    def os_setup = params.os_packages
        ? "apt-get update\n    apt-get install -y --no-install-recommends ${params.os_packages}"
        : 'true'
    """
    ${os_setup}

    # Keep the session's working set (unpacked stores, raster tiles) on the work
    # filesystem rather than the container's /tmp, and let admission control see the
    # memory this task was actually given.
    mkdir -p .sds-work
    export SDS_WORK_DIR="\$PWD/.sds-work"
    export SDS_CONTAINER_MEM_MB=${task.memory.toMega()}
    export MPLBACKEND=Agg

    # Isolated venv with pinned deps (squidpy requires Python 3.11; not 3.13+).
    # uv discovers ./.venv automatically for the subsequent pip install.
    uv venv --python 3.11
    uv pip install -r ${backend}/requirements.txt

    .venv/bin/python ${backend}/cli.py \\
        --parser io.xenium \\
        --input ${xenium_dir} \\
        ${recipe_args} \\
        --recipe-params '${recipe_params}' \\
        --output . \\
        --name ${sample}.sdata \\
        ${lowres_arg} \\
        ${reader_params_arg}

    .venv/bin/python ${metrics_script} \\
        --sample ${sample} \\
        --checkpoint ${sample}.sdata.zarr.zip \\
        --xenium-dir ${xenium_dir} \\
        --cluster-key ${params.cluster_key} \\
        --neighborhood-key ${params.neighborhood_key}
    """
}

process MULTIQC {
    container params.multiqc_container

    publishDir "${params.outdir}/multiqc", mode: 'copy'

    input:
    path 'sections/*'
    path multiqc_config

    output:
    path 'multiqc_report.html'
    path 'multiqc_report_data'   // MultiQC names the data dir after --filename

    script:
    def title = params.title.replace("'", "'\\''")   // survives the single-quoted shell word
    """
    multiqc --config ${multiqc_config} \\
        --title '${title}' \\
        --filename multiqc_report.html \\
        --outdir . \\
        sections
    """
}

process PUBLISH_VIEWER {
    container 'ghcr.io/astral-sh/uv:python3.11-bookworm'

    // Published file by file, not as one directory: XENIUM_ANALYSIS puts the
    // checkpoints in this same folder, and publishing a directory replaces the target
    // rather than merging into it.
    publishDir "${params.outdir}/viewer", mode: 'copy',
               saveAs: { f -> f.toString().tokenize('/').drop(1).join('/') }

    input:
    path viewer_dist
    val  manifest

    output:
    path 'site/**'

    script:
    // index.json is what turns a folder of checkpoints into a browsable serverless
    // deployment (DESIGN §14.3); the checkpoints themselves are published into this
    // same folder by XENIUM_ANALYSIS. Sorted so the listing order is run-independent,
    // with each sample's low-res copy (when there is one) just after its full one.
    // How cli.py --lowres-copy names the reduced checkpoint beside the full one.
    def lowres_suffix = '.lowres.zarr.zip'
    def entries = manifest
        .collect { sample, name -> [sample: sample, path: name, lowres: name.endsWith(lowres_suffix)] }
        .sort { a, b -> (a.sample <=> b.sample) ?: ((a.lowres ? 1 : 0) <=> (b.lowres ? 1 : 0)) }
        .collect { e -> e.lowres
            ? [path: e.path, label: "${e.sample} (low-res image)".toString(),
               description: 'The same analysis with the finest image level dropped: a much ' +
                            'smaller file that renders everything but the deepest zoom.']
            : [path: e.path, label: e.sample] }
    def index_json = groovy.json.JsonOutput.prettyPrint(
        groovy.json.JsonOutput.toJson([title: params.title, checkpoints: entries]))
    """
    mkdir site
    cp -RL ${viewer_dist}/. site/
    cat > site/index.json <<'INDEX_JSON'
${index_json}
INDEX_JSON
    """
}

workflow {
    if( !params.input ) error "Missing --input (comma-separated list of Xenium bundle folders)"

    // Sample names become file names, publish paths and shell words in the processes
    // above, so they are held to a conservative character set rather than escaped
    // everywhere.
    def sample_name = ~/[A-Za-z0-9][A-Za-z0-9._-]*/
    def samples = params.input.tokenize(',')
        .collect { entry -> entry.trim() }
        .findAll { entry -> entry }
        .collect { entry ->
            def dir = file(entry)
            if( !dir.isDirectory() ) error "--input entry is not a directory: ${entry}"
            if( !(dir.name ==~ sample_name) )
                error "folder name '${dir.name}' is not usable as a sample name " +
                      "(letters, digits, '.', '_' and '-' only): ${entry}"
            [dir.name, dir]
        }
    if( !samples ) error "--input listed no folders"
    def repeated = samples.countBy { pair -> pair[0] }.findAll { _name, count -> count > 1 }.keySet()
    if( repeated ) error "--input folders share the name(s) ${repeated.join(', ')}; " +
                         "sample names come from the folder name and must be unique"

    // A built SPA is the one input this workflow does not produce: the repo builds it
    // once (`npm ci && npm run build`) for the docs site and the Docker image alike.
    def viewer_dist = file(params.viewer_dist)
    if( !viewer_dist.resolve('index.html').exists() )
        error "no built viewer at ${viewer_dist} (expected index.html there). Build it with " +
              "`npm ci && npm run build` at the repo root, or point --viewer_dist at a build."

    XENIUM_ANALYSIS(
        channel.fromList(samples),
        file(params.backend),
        file("${projectDir}/bin/xenium_metrics.py"),
    )

    MULTIQC(
        XENIUM_ANALYSIS.out.metrics.collect(),
        file("${projectDir}/multiqc_config.yml"),
    )

    PUBLISH_VIEWER(
        viewer_dist,
        // A sample emits one checkpoint, or two under --lowres_copy; both are listed.
        XENIUM_ANALYSIS.out.checkpoint
            .flatMap { sample, ckpts ->
                (ckpts instanceof List ? ckpts : [ckpts]).collect { ckpt -> [sample, ckpt.name] }
            }
            .toList(),
    )
}
