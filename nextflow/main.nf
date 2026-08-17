#!/usr/bin/env nextflow

nextflow.enable.dsl = 2

// The repo's single workflow entrypoint. Point it at a folder (or several), and it
// finds the spatial datasets inside, loads each with the right reader, runs that data
// type's preprocessing recipes, and publishes the results in a tree mirroring where
// they were found — plus a MultiQC report over the whole run and a browsable viewer.
//
// No part of this file knows about any particular data type. Recognition patterns,
// reader names, recipes and which parameters apply to which type all come from
// data_types.json (schema: data_types.schema.json); parameters are described in
// nextflow_schema.json. Adding a format is an edit to those files.
//
// Dependencies are installed at runtime with uv, so there is no image to build.

include { discoverCandidates } from './modules/discovery.nf'

process ANALYSE {
    tag "${prefix} (${spec.label})"
    container params.analysis_container

    // Everything this candidate produces is already laid out under out/ exactly as it
    // should be published, so publishing is a straight copy with the wrapper stripped.
    publishDir "${params.outdir}/results", mode: 'copy', pattern: 'out/**',
               saveAs: { f -> f.toString().tokenize('/').drop(1).join('/') }

    input:
    tuple val(prefix), val(spec), path(data_dir)
    // The whole backend/ tree (cli.py + app/, which carries the recipes) is needed at
    // runtime; stage it so cli.py and its `app` package resolve on any executor.
    path backend
    path metrics_script

    output:
    // The log is always written, so this never comes back empty — a candidate that
    // failed to load publishes its log and nothing else.
    path 'out/**', emit: published
    tuple val(prefix), path("out/${spec.base}.sdata.zarr.zip"), optional: true, emit: checkpoint
    path '*_mqc.json', emit: metrics

    script:
    def recipe_args = spec.recipes
        .collect { recipe -> "--recipe ${backend}/app/recipes/${recipe}" }
        .join(' \\\n        ')
    def reader_params_arg = spec.reader_params_json
        ? "--reader-params '${spec.reader_params_json}'" : ''
    // Two statements rather than an `&&` chain: `set -e` does not abort on the left
    // operand of `&&`, so a chain would let a failed install fall through to a
    // confusing ImportError several minutes later instead of stopping here.
    def os_setup = params.os_packages
        ? "apt-get update\n    apt-get install -y --no-install-recommends ${params.os_packages}"
        : 'true'
    """
    ${os_setup}

    mkdir -p '${spec.out_dir}'

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

    # Reading and analysing is the part allowed to fail: a folder can look like a data
    # type and still be truncated, mis-exported or unreadable. Its log is published and
    # the run carries on with the other candidates, rather than one bad folder in a
    # thousand aborting the sweep. A broken venv above is not caught — that is the
    # environment failing, not the data.
    set +e
    .venv/bin/python ${backend}/cli.py \\
        --parser ${spec.reader} \\
        --input ${data_dir} \\
        ${recipe_args} \\
        --recipe-params '${spec.recipe_params_json}' \\
        --lowres-max-image-mb ${params.lowres_max_image_mb} \\
        --output '${spec.out_dir}' \\
        --name '${spec.base}.sdata' \\
        ${reader_params_arg} 2>&1 | tee '${spec.out_dir}/${spec.base}.log'
    rc=\${PIPESTATUS[0]}
    set -e

    # cli.py writes plots to <output>/plots; name them after the candidate so two
    # candidates published into the same folder cannot collide.
    if [ -d '${spec.out_dir}/plots' ]; then
        mv '${spec.out_dir}/plots' '${spec.out_dir}/${spec.base}.plots'
    fi

    if [ "\$rc" -eq 0 ]; then
        .venv/bin/python ${metrics_script} \\
            --sample '${prefix}' \\
            --data-type '${spec.id}' \\
            --status ok \\
            --checkpoint '${spec.out_dir}/${spec.base}.sdata.zarr.zip' \\
            --source-dir ${data_dir} \\
            --run-metrics '${spec.run_metrics_json}' \\
            --cluster-key '${params.cluster_key}' \\
            --neighborhood-key '${params.neighborhood_key}'
    else
        echo "WARN: ${prefix} (${spec.id}) failed; see ${spec.base}.log" >&2
        .venv/bin/python ${metrics_script} \\
            --sample '${prefix}' \\
            --data-type '${spec.id}' \\
            --status failed
    fi
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
    container params.analysis_container

    // Published file by file rather than as one directory: the checkpoints and the
    // MultiQC report land in this same tree, and publishing a directory replaces the
    // target instead of merging into it.
    publishDir params.outdir, mode: 'copy',
               saveAs: { f -> f.toString().tokenize('/').drop(1).join('/') }

    input:
    path viewer_dist
    val  manifest

    output:
    path 'site/**'

    script:
    // index.json is what turns a folder of checkpoints into a browsable serverless
    // deployment (DESIGN §14.3). The SPA sits at the publish root so that `results/…`
    // paths resolve from it; serving the whole outdir therefore renders the run.
    // Sorted so the listing order does not depend on which task finished first.
    def entries = manifest
        .collect { prefix, path -> [prefix: prefix, path: "results/${path}".toString(),
                                    lowres: path.endsWith('.lowres.zarr.zip')] }
        .sort { a, b -> (a.prefix <=> b.prefix) ?: ((a.lowres ? 1 : 0) <=> (b.lowres ? 1 : 0)) }
        .collect { e -> e.lowres
            ? [path: e.path, label: "${e.prefix} (low-res image)".toString(),
               description: 'The same analysis with the image pyramid capped: a much ' +
                            'smaller file that renders everything but the deepest zoom.']
            : [path: e.path, label: e.prefix] }
    def index_json = groovy.json.JsonOutput.prettyPrint(
        groovy.json.JsonOutput.toJson([title: params.title, checkpoints: entries]))
    """
    mkdir site
    if [ -d ${viewer_dist} ]; then
        cp -RL ${viewer_dist}/. site/
    else
        tar -xzf ${viewer_dist} -C site
    fi
    cat > site/index.json <<'INDEX_JSON'
${index_json}
INDEX_JSON
    """
}

// ---------------------------------------------------------------------------
// Catalog and input plumbing. Generic: the only thing these read out of the
// catalog is structure the schema guarantees.
// ---------------------------------------------------------------------------

/** Parse a .json/.yaml/.yml file into a Map/List. */
def parseStructured(path) {
    def text = path.text
    return path.name.toLowerCase().endsWith('.json')
        ? new groovy.json.JsonSlurper().parseText(text)
        : new org.yaml.snakeyaml.Yaml().load(text)
}

/** `--input` as a list of `[output_prefix, root]`.
 *
 * A directory is one unnamed root: prefixes are then relative to it, so the layout
 * does not change when the same tree is passed by a different path. A .json/.yaml file
 * is an object of `output prefix -> root`, which is how several unrelated locations
 * (possibly on different storage) are processed into one organised output tree.
 */
def inputRoots(String spec) {
    def entry = file(spec)
    if( entry.isDirectory() ) return [['', entry]]
    if( !entry.exists() ) error "--input does not exist: ${spec}"
    def mapping = parseStructured(entry)
    if( !(mapping instanceof Map) || !mapping )
        error "--input file ${spec} must hold an object of \"output prefix\": \"folder\" pairs"
    return mapping.collect { prefix, root ->
        def dir = file(root.toString())
        if( !dir.exists() ) error "--input entry '${prefix}' points at a missing folder: ${root}"
        [prefix.toString().replaceAll('^/+', '').replaceAll('/+$', ''), dir]
    }
}

/** The recipe-parameter values that apply to one data type: every common parameter
 *  whose `applies_to` names it, under each recipe-parameter name it fills. */
def recipeParamsFor(Map catalog, String typeId) {
    def values = [:]
    catalog.common_params.each { name, param ->
        if( !param.applies_to.contains(typeId) ) return
        param.recipe_params.each { target -> values[target] = params[name] }
    }
    return values
}

workflow {
    if( !params.input ) error "Missing --input (a data folder, or a .json/.yaml file of prefix -> folder)"

    def catalog = parseStructured(file(params.catalog))
    def wanted = params.data_types
        ? params.data_types.toString().tokenize(',').collect { t -> t.trim() }.findAll { t -> t }
        : null
    def known = catalog.data_types.collect { type -> type.id }
    def unknown = wanted ? wanted.findAll { t -> !known.contains(t) } : []
    if( unknown ) error "--data_types names unknown type(s) ${unknown.join(', ')}; known: ${known.join(', ')}"
    def types = wanted ? catalog.data_types.findAll { type -> wanted.contains(type.id) } : catalog.data_types

    // Discovery runs here rather than in a task: Nextflow's own file() reaches s3://,
    // gs:// and az:// with the credentials the executor already has, so a root can live
    // anywhere without this workflow shipping a storage client of its own.
    def candidates = inputRoots(params.input.toString())
        .collectMany { prefix, root -> discoverCandidates(root, prefix, types, params.recurse as boolean) }
    if( !candidates )
        error "no data folders found under --input ${params.input}. Looked for: " +
              "${types.collect { type -> type.id }.join(', ')}" +
              (params.recurse ? '' : ' (--recurse is off, so only the root folders themselves were tested)')

    def byType = candidates.countBy { candidate -> candidate[1] }
    log.info "Found ${candidates.size()} dataset(s): " +
             byType.collect { id, n -> "${n} ${id}" }.sort().join(', ')

    def work = candidates.collect { prefix, typeId, dir ->
        def type = catalog.data_types.find { t -> t.id == typeId }
        def at = prefix ?: dir.name       // a bare root that is itself the dataset
        def cut = at.lastIndexOf('/')
        tuple(at, [
            id              : typeId,
            label           : type.label,
            reader          : type.reader,
            base            : cut < 0 ? at : at.substring(cut + 1),
            out_dir         : cut < 0 ? 'out' : "out/${at.substring(0, cut)}".toString(),
            recipes         : params.preprocess ? type.recipes : [],
            recipe_params_json : groovy.json.JsonOutput.toJson(recipeParamsFor(catalog, typeId)),
            reader_params_json : type.reader_params
                ? groovy.json.JsonOutput.toJson(type.reader_params) : null,
            run_metrics_json   : groovy.json.JsonOutput.toJson(type.run_metrics ?: [:]),
        ], dir)
    }

    // A built SPA is the one input this workflow does not produce: the repo builds it
    // once (`npm ci && npm run build`) for the docs site and the Docker image alike, and
    // CI attaches that build to each release as viewer-dist.tar.gz, which is the default.
    // Either form works here; only a local one can be checked before the run, since a
    // remote archive is fetched when PUBLISH_VIEWER stages it.
    def viewer_dist = file(params.viewer_dist)
    def viewer_is_remote = params.viewer_dist.toString().contains('://')
    if( !viewer_is_remote && !(viewer_dist.isDirectory()
                                   ? viewer_dist.resolve('index.html').exists()
                                   : viewer_dist.exists()) )
        error "no built viewer at ${viewer_dist}. Build one with `npm ci && npm run build` " +
              "at the repo root (writes frontend/dist), or point --viewer_dist at a " +
              "viewer-dist.tar.gz from a release."

    ANALYSE(
        channel.fromList(work),
        file(params.backend),
        file("${projectDir}/bin/dataset_metrics.py"),
    )

    MULTIQC(
        ANALYSE.out.metrics.collect(),
        file("${projectDir}/multiqc_config.yml"),
    )

    PUBLISH_VIEWER(
        viewer_dist,
        // The full checkpoint and its low-res copy are separate entries in the listing.
        ANALYSE.out.published
            .flatten()
            .map { f -> f.toString() }
            .filter { f -> f.endsWith('.zarr.zip') }
            .map { f ->
                def rel = f.substring(f.indexOf('/out/') + '/out/'.length())
                // cli.py appends `.lowres` to the --name it was given, so the pair is
                // `<prefix>.sdata.zarr.zip` and `<prefix>.sdata.lowres.zarr.zip`.
                [rel.replaceAll('\\.sdata(\\.lowres)?\\.zarr\\.zip$', ''), rel]
            }
            .toList(),
    )
}
