import path from 'path'
import {
  progressLogger,
} from '@pnpm/core-loggers'
import {
  Lockfile,
} from '@pnpm/lockfile-file'
import {
  nameVerFromPkgSnapshot,
  packageIdFromSnapshot,
  pkgSnapshotToResolution,
} from '@pnpm/lockfile-utils'
import { IncludedDependencies } from '@pnpm/modules-yaml'
import packageIsInstallable from '@pnpm/package-is-installable'
import { Registries } from '@pnpm/types'
import {
  FetchPackageToStoreFunction,
  StoreController,
} from '@pnpm/store-controller-types'
import hoist, { HoisterResult } from '@pnpm/real-hoist'
import {
  DependenciesGraph,
  DepHierarchy,
  DirectDependenciesByImporterId,
  LockfileToDepGraphResult,
} from './lockfileToDepGraph'

export interface LockfileToHoistedDepGraphOptions {
  engineStrict: boolean
  force: boolean
  importerIds: string[]
  include: IncludedDependencies
  lockfileDir: string
  nodeVersion: string
  pnpmVersion: string
  registries: Registries
  sideEffectsCacheRead: boolean
  skipped: Set<string>
  storeController: StoreController
  storeDir: string
  virtualStoreDir: string
}

export default async function lockfileToHoistedDepGraph (
  lockfile: Lockfile,
  opts: LockfileToHoistedDepGraphOptions
): Promise<LockfileToDepGraphResult> {
  const tree = hoist(lockfile)
  const graph: DependenciesGraph = {}
  const hierarchy = await fetchDeps(lockfile, opts, graph, path.join(opts.lockfileDir, 'node_modules'), tree.dependencies)
  const directDependenciesByImporterId: DirectDependenciesByImporterId = { '.': {} }
  for (const rootDep of Array.from(tree.dependencies)) {
    directDependenciesByImporterId['.'][rootDep.name] = Array.from(rootDep.references)[0]
  }
  return { directDependenciesByImporterId, graph, hierarchy }
}

async function fetchDeps (
  lockfile: Lockfile,
  opts: LockfileToHoistedDepGraphOptions,
  graph: DependenciesGraph,
  modules: string,
  deps: Set<HoisterResult>
): Promise<DepHierarchy> {
  const depHierarchy = {}
  await Promise.all(Array.from(deps).map(async (dep) => {
    const depPath = Array.from(dep.references)[0]
    if (opts.skipped.has(depPath)) return
    const pkgSnapshot = lockfile.packages![depPath]
    // TODO: optimize. This info can be already returned by pkgSnapshotToResolution()
    const { name: pkgName, version: pkgVersion } = nameVerFromPkgSnapshot(depPath, pkgSnapshot)
    const packageId = packageIdFromSnapshot(depPath, pkgSnapshot, opts.registries)

    const pkg = {
      name: pkgName,
      version: pkgVersion,
      engines: pkgSnapshot.engines,
      cpu: pkgSnapshot.cpu,
      os: pkgSnapshot.os,
    }
    if (!opts.force &&
      packageIsInstallable(packageId, pkg, {
        engineStrict: opts.engineStrict,
        lockfileDir: opts.lockfileDir,
        nodeVersion: opts.nodeVersion,
        optional: pkgSnapshot.optional === true,
        pnpmVersion: opts.pnpmVersion,
      }) === false
    ) {
      opts.skipped.add(depPath)
      return
    }
    const dir = path.join(modules, dep.name)
    const resolution = pkgSnapshotToResolution(depPath, pkgSnapshot, opts.registries)
    progressLogger.debug({
      packageId,
      requester: opts.lockfileDir,
      status: 'resolved',
    })
    let fetchResponse!: ReturnType<FetchPackageToStoreFunction>
    try {
      fetchResponse = opts.storeController.fetchPackage({
        force: false,
        lockfileDir: opts.lockfileDir,
        pkg: {
          name: pkgName,
          version: pkgVersion,
          id: packageId,
          resolution,
        },
      })
      if (fetchResponse instanceof Promise) fetchResponse = await fetchResponse
    } catch (err: any) { // eslint-disable-line
      if (pkgSnapshot.optional) return
      throw err
    }
    fetchResponse.files() // eslint-disable-line
      .then(({ fromStore }) => {
        progressLogger.debug({
          packageId,
          requester: opts.lockfileDir,
          status: fromStore
            ? 'found_in_store'
            : 'fetched',
        })
      })
      .catch(() => {
        // ignore
      })
    graph[dir] = {
      children: {},
      depPath,
      dir,
      fetchingFiles: fetchResponse.files,
      filesIndexFile: fetchResponse.filesIndexFile,
      finishing: fetchResponse.finishing,
      hasBin: pkgSnapshot.hasBin === true,
      hasBundledDependencies: pkgSnapshot.bundledDependencies != null,
      modules,
      name: pkgName,
      optional: !!pkgSnapshot.optional,
      optionalDependencies: new Set(Object.keys(pkgSnapshot.optionalDependencies ?? {})),
      prepare: pkgSnapshot.prepare === true,
      requiresBuild: pkgSnapshot.requiresBuild === true,
    }
    depHierarchy[dir] = await fetchDeps(lockfile, opts, graph, path.join(dir, 'node_modules'), dep.dependencies)
  }))
  return depHierarchy
}
