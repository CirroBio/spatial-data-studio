#!/usr/bin/env nextflow

nextflow.enable.dsl = 2

// Wrap backend/cli.py (the headless recipe runner) as a single-process workflow.
// Dependencies are installed at runtime with uv, so no custom image is built or
// maintained here; see nextflow/README.md for the rationale.
process RUN_ANALYSIS {
    tag "${parser}"
    publishDir params.outdir, mode: 'copy'

    input:
    // input_data may be a directory (raw-reader bundle) or a file (.zarr / .zarr.zip);
    // staging as `path` lets Nextflow localize either into the task work dir.
    path input_data
    path recipe
    val  parser
    val  sample_name
    // The whole backend/ tree (cli.py + app/) is needed at runtime; stage it so
    // cli.py and its `app` package resolve regardless of the executor.
    path backend

    output:
    path "analysis"

    script:
    def name_arg = sample_name ? "--name ${sample_name}" : ''
    def reader_params_arg = params.reader_params ? "--reader-params '${params.reader_params}'" : ''
    // Optional apt packages for image-backed readers/plots (e.g. 'libgl1 libglib2.0-0 libgomp1').
    // Runs only when set; the docker container runs as root, so apt-get works there.
    def os_setup = params.os_packages ? "apt-get update && apt-get install -y --no-install-recommends ${params.os_packages}" : 'true'
    """
    ${os_setup}

    # Isolated venv with pinned deps (squidpy requires Python 3.11; not 3.13+).
    # uv discovers ./.venv automatically for the subsequent pip install.
    uv venv --python 3.11
    uv pip install -r ${backend}/requirements.txt

    .venv/bin/python ${backend}/cli.py \\
        --parser ${parser} \\
        --input ${input_data} \\
        --recipe ${recipe} \\
        --output analysis \\
        ${name_arg} \\
        ${reader_params_arg}
    """
}

workflow {
    if( !params.input )  error "Missing --input (raw data folder, or .zarr/.zarr.zip in zarr mode)"
    if( !params.recipe ) error "Missing --recipe (recipe JSON file or bundled recipe name)"
    if( !params.parser ) error "Missing --parser (reader key like io.xenium, or 'zarr')"

    RUN_ANALYSIS(
        file(params.input),
        file(params.recipe),
        params.parser,
        params.name ?: '',
        file(params.backend)
    )
}
