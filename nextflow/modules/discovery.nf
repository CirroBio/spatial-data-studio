// Finding folders of spatial data in an input tree.
//
// Nothing here knows about any particular data type: every pattern, every
// disambiguation rule and every reader name comes from data_types.json (see
// data_types.schema.json). Adding support for a format is an edit to that file.
//
// Listing goes through Nextflow's `file()` API rather than a shell or an SDK, so a
// root may equally be a local path, `s3://`, `gs://` or `az://` — whatever the
// executor is already configured to read.

// Glob -> regex over a single path segment. Only `*` and `?` are meaningful; every
// other character is matched literally, so a pattern like `cells.h5ad` cannot have
// its dot read as "any character".
def globToRegex(String glob) {
    return glob.collect { ch ->
        ch == '*' ? '.*' : (ch == '?' ? '.' : java.util.regex.Pattern.quote(ch))
    }.join('')
}

// Immediate child names of `dir`, or an empty list when it is absent or unreadable.
// Absence is the normal case while walking — most directories are not data folders —
// so it is not an error.
def childNames(dir) {
    try {
        if( !dir.exists() || !dir.isDirectory() ) return []
        return dir.list().collect { name -> name.toString() }
    }
    catch( Exception _e ) {
        return []
    }
}

// Whether `pattern` matches something in `dir`. A pattern containing '/' is resolved
// against that subfolder, so nesting stays explicit and testing one folder never walks
// a whole tree. `listings` memoises directory listings, which on object storage is the
// difference between one LIST per folder and one per pattern.
def patternPresent(dir, String pattern, Map listings) {
    def slash = pattern.lastIndexOf('/')
    def target = slash < 0 ? dir : dir.resolve(pattern.substring(0, slash))
    def leaf = slash < 0 ? pattern : pattern.substring(slash + 1)
    def key = target.toUriString()
    if( !listings.containsKey(key) ) listings[key] = childNames(target)
    def regex = globToRegex(leaf)
    return listings[key].any { name -> name ==~ regex }
}

// Whether `dir` satisfies a data type's `detect` block: every all_of present, every
// any_of group represented, no none_of present.
def detectMatches(dir, Map detect, Map listings) {
    def allOf = (detect.all_of ?: []) as List
    def anyOf = (detect.any_of ?: []) as List
    def noneOf = (detect.none_of ?: []) as List

    if( !allOf.every { pattern -> patternPresent(dir, pattern, listings) } ) return false
    if( !anyOf.every { group -> group.any { pattern -> patternPresent(dir, pattern, listings) } } ) return false
    if( noneOf.any { pattern -> patternPresent(dir, pattern, listings) } ) return false
    return true
}

// How much a `detect` block asserts. Used only to rank competing matches, so a format
// that is a superset of another (Visium HD over Visium) wins without a special case.
def detectScore(Map detect) {
    return ((detect.all_of ?: []).size() + (detect.any_of ?: []).size()) as int
}

// The data type `dir` holds, or null. When several match, the most specific wins. A
// genuine tie is a catalog bug rather than a data problem, so it stops the run.
def classify(dir, List types, Map listings) {
    def matched = types.findAll { type -> detectMatches(dir, type.detect, listings) }
    if( !matched ) return null
    def best = matched.max { type -> detectScore(type.detect) }
    def tied = matched.findAll { type -> detectScore(type.detect) == detectScore(best.detect) }
    if( tied.size() > 1 )
        error "folder ${dir} matches ${tied.collect { type -> type.id }.join(' and ')} equally; " +
              "make one of their `detect` blocks more specific in data_types.json"
    return best
}

// Depth-first walk. Greedy: a folder that classifies is a candidate and is not
// descended into, so a format that nests its own sub-outputs yields one result rather
// than several. Written as recursion because the workflow language has no loops.
def collectFrom(dir, String at, List types, boolean recurse, Map listings) {
    def type = classify(dir, types, listings)
    if( type ) return [[at, type.id, dir]]
    if( !recurse ) return []
    return childNames(dir).sort().collectMany { name ->
        def child = dir.resolve(name)
        return child.isDirectory()
            ? collectFrom(child, at ? "${at}/${name}".toString() : name, types, recurse, listings)
            : []
    }
}

/** Data folders under `root`, each as `[prefix, data_type_id, path]`.
 *
 * `prefix` is where the result is published: the caller's prefix for the root itself,
 * extended by the candidate's path relative to the root.
 *
 * With `recurse` false only `root` itself is tested, which is the "this is my data
 * folder" case rather than the "go and find them" one.
 */
def discoverCandidates(root, String prefix, List types, boolean recurse) {
    return collectFrom(root, prefix, types, recurse, [:])
}
