const { promises: fs } = require('fs')
const path = require('path')
const npmRunScript = require('@npmcli/run-script')
const {
  loadTree,
  getQualifiedNameDataForTreeNode,
  eachNodeInTree
} = require('@lavamoat/lava-tree')

module.exports = {
  // primary
  runAllowedPackages,
  setDefaultConfiguration,
  printPackagesList,
  // util
  loadAllPackageConfigurations
}

async function runAllowedPackages ({ projectDir }) {
  const {
    packagesWithLifecycleScripts,
    allowedPatterns,
    missingPolicies
  } = await loadAllPackageConfigurations({ projectDir })

  if (missingPolicies.length) {
    console.log('\n@lavamoat/allow-scripts has detected dependencies without configuration. explicit configuration required.')
    console.log('run "allow-scripts auto" to automatically populate the configuration.\n')

    console.log('packages missing configuration:')
    missingPolicies.forEach(pattern => {
      const collection = packagesWithLifecycleScripts.get(pattern) || []
      console.log(`- ${pattern} [${collection.length} location(s)]`)
    })

    // exit with error
    process.exit(1)
  }

  // run scripts in dependencies
  if (allowedPatterns.length) {
    const allowedPackagesWithLifecycleScripts = [].concat(...Array.from(packagesWithLifecycleScripts.entries())
      .filter(([pattern]) => allowedPatterns.includes(pattern))
      .map(([, packages]) => packages)
    )

    console.log('running lifecycle scripts for event "preinstall"')
    await runAllScriptsForEvent({ event: 'preinstall', packages: allowedPackagesWithLifecycleScripts })
    console.log('running lifecycle scripts for event "install"')
    await runAllScriptsForEvent({ event: 'install', packages: allowedPackagesWithLifecycleScripts })
    console.log('running lifecycle scripts for event "postinstall"')
    await runAllScriptsForEvent({ event: 'postinstall', packages: allowedPackagesWithLifecycleScripts })
  } else {
    console.log('no allowed scripts found in configuration')
  }

  // run scripts in top-level package
  console.log('running lifecycle scripts for top level package')
  await runScript({ event: 'install', path: projectDir })
  await runScript({ event: 'postinstall', path: projectDir })
  await runScript({ event: 'prepublish', path: projectDir })
  await runScript({ event: 'prepare', path: projectDir })
}

async function runAllScriptsForEvent ({ event, packages }) {
  for (const { qualifiedName, path, scripts } of packages) {
    if (event in scripts) {
      console.log(`- ${qualifiedName}`)
      await runScript({ path, event })
    }
  }
}

async function runScript ({ path, event }) {
  await npmRunScript({
    // required, the script to run
    // event: 'install',
    event,
    // required, the folder where the package lives
    // path: '/path/to/package/folder',
    path,
    // optional, defaults to false
    // return stdout and stderr as strings rather than buffers
    stdioString: true,
    // print the package id and script, and the command to be run, like:
    // > somepackage@1.2.3 postinstall
    // > make all-the-things
    // Defaults true when stdio:'inherit', otherwise suppressed
    banner: true
  })
}

async function setDefaultConfiguration ({ projectDir }) {
  const {
    packageJson,
    allowScriptsConfig,
    missingPolicies,
    excessPolicies
  } = await loadAllPackageConfigurations({ projectDir })

  console.log('\n@lavamoat/allow-scripts automatically updating configuration')

  if (!missingPolicies.length && !excessPolicies.length) {
    console.log('\nconfiguration looks good as is, no changes necesary')
    return
  }

  if (missingPolicies.length) {
    console.log('\nadding configuration for missing packages:')
    missingPolicies.forEach(pattern => {
      console.log(`- ${pattern}`)
      allowScriptsConfig[pattern] = false
    })
  }

  if (excessPolicies.length) {
    console.log('\nremoving unneeded configuration for packages:')
    excessPolicies.forEach(pattern => {
      console.log(`- ${pattern}`)
      delete allowScriptsConfig[pattern]
    })
  }

  // update package json
  if (!packageJson.lavamoat) packageJson.lavamoat = {}
  packageJson.lavamoat.allowScripts = allowScriptsConfig
  const packageJsonPath = path.resolve(projectDir, 'package.json')
  const packageJsonSerialized = JSON.stringify(packageJson, null, 2)
  await fs.writeFile(packageJsonPath, packageJsonSerialized)
}

async function printPackagesList ({ projectDir }) {
  const {
    packagesWithLifecycleScripts,
    allowedPatterns,
    disallowedPatterns,
    missingPolicies,
    excessPolicies
  } = await loadAllPackageConfigurations({ projectDir })

  console.log('\n# allowed packages')
  if (allowedPatterns.length) {
    allowedPatterns.forEach(pattern => {
      const collection = packagesWithLifecycleScripts.get(pattern) || []
      console.log(`- ${pattern} [${collection.length} location(s)]`)
    })
  } else {
    console.log('  (none)')
  }

  console.log('\n# disallowed packages')
  if (disallowedPatterns.length) {
    disallowedPatterns.forEach(pattern => {
      const collection = packagesWithLifecycleScripts.get(pattern) || []
      console.log(`- ${pattern} [${collection.length} location(s)]`)
    })
  } else {
    console.log('  (none)')
  }

  if (missingPolicies.length) {
    console.log('\n# unconfigured packages!')
    missingPolicies.forEach(pattern => {
      const collection = packagesWithLifecycleScripts.get(pattern) || []
      console.log(`- ${pattern} [${collection.length} location(s)]`)
    })
  }

  if (excessPolicies.length) {
    console.log('\n# packages that dont need configuration (missing or no lifecycle scripts)')
    excessPolicies.forEach(pattern => {
      const collection = packagesWithLifecycleScripts.get(pattern) || []
      console.log(`- ${pattern} [${collection.length} location(s)]`)
    })
  }
}

function getAllowedScriptsConfig (packageJson) {
  const lavamoatConfig = packageJson.lavamoat || {}
  return lavamoatConfig.allowScripts || {}
}

async function loadAllPackageConfigurations ({ projectDir }) {
  const { tree, packageJson } = await loadTree({ projectDir })

  const packagesWithLifecycleScripts = new Map()
  for (const { node, branch } of eachNodeInTree(tree)) {
    const { qualifiedName } = getQualifiedNameDataForTreeNode(node)

    const nodePath = node.path()

    // TODO: follow symbolic links? I couldnt find any in my test repo,
    let depPackageJson
    try {
      depPackageJson = JSON.parse(await fs.readFile(path.resolve(nodePath, 'package.json')))
    } catch (err) {
      const branchIsOptional = branch.some(node => node.optional)
      if (err.code === 'ENOENT' && branchIsOptional) {
        continue
      }
      throw err
    }
    const depScripts = depPackageJson.scripts || {}
    const lifeCycleScripts = ['preinstall', 'install', 'postinstall'].filter(name => {
      return Object.prototype.hasOwnProperty.call(depScripts, name)
    })

    if (lifeCycleScripts.length) {
      const collection = packagesWithLifecycleScripts.get(qualifiedName) || []
      collection.push({
        qualifiedName,
        path: nodePath,
        scripts: depScripts
      })
      packagesWithLifecycleScripts.set(qualifiedName, collection)
    }
  }
  // return

  const allowScriptsConfig = getAllowedScriptsConfig(packageJson)
  // const packages = await parseYarnLockForPackages()

  // packages with config
  const configuredPatterns = Object.keys(allowScriptsConfig)
  // const packagesWithMatchingPatterns = packages filter for configuredPatterns

  // select allowed + disallowed
  const allowedPatterns = Object.entries(allowScriptsConfig).filter(([pattern, packageData]) => packageData === true).map(([pattern]) => pattern)
  const disallowedPatterns = Object.entries(allowScriptsConfig).filter(([pattern, packageData]) => packageData === false).map(([pattern]) => pattern)
  const missingPolicies = [...packagesWithLifecycleScripts.keys()]
    .filter(pattern => packagesWithLifecycleScripts.has(pattern))
    .filter(pattern => !configuredPatterns.includes(pattern))
  const excessPolicies = Object.keys(allowScriptsConfig).filter(pattern => !packagesWithLifecycleScripts.has(pattern))

  // const nonCanonicalPackages = packages.filter(packageData => packageData.namespace !== 'npm')
  // console.log(nonCanonicalPackages.map(packageData => packageData.qualifiedName).join('\n'))

  return {
    tree,
    packageJson,
    allowScriptsConfig,
    packagesWithLifecycleScripts,
    allowedPatterns,
    disallowedPatterns,
    missingPolicies,
    excessPolicies
  }
}
