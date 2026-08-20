#!/usr/bin/env nextflow

// Discovery check: builds no data, runs no analysis — walks a tree with the real
// catalog and prints what it classified, as `<prefix>\t<data type>`, followed by one
// `companion\t<prefix>\t<file>\t<missing companion>` line per unsatisfied
// `companion_files` rule. Used by tests/check_catalog.py, which lays out a synthetic tree
// of each type (including a Visium HD run that also looks like Visium, a folder that is
// nothing, and an aligned image with and without its alignment file) and asserts on the
// result.
//
//   nextflow run nextflow/tests/discovery_test.nf --root <dir> [--recurse false]

nextflow.enable.dsl = 2

include { discoverCandidates ; missingCompanions } from '../modules/discovery.nf'

params.root = null
params.recurse = true
params.catalog = "${projectDir}/../data_types.json"

workflow {
    if( !params.root ) error "Missing --root"
    def catalog = new groovy.json.JsonSlurper().parseText(file(params.catalog).text)
    def found = discoverCandidates(file(params.root), '', catalog.data_types, params.recurse as boolean)
        .sort { candidate -> candidate[0] }
    found.each { at, id, _dir -> println "${at}\t${id}" }
    found.each { at, id, dir ->
        def rules = catalog.data_types.find { type -> type.id == id }.companion_files
        if( !rules ) return
        missingCompanions(dir, rules).each { pair ->
            println "companion\t${at}\t${pair.file}\t${pair.companion}"
        }
    }
}
