const { Command, flags } = require('@oclif/command')
const API = require('netlify')
const merge = require('lodash.merge')
const { format, inspect } = require('util')
const { URL } = require('url')
const { track, identify } = require('./telemetry')
const openBrowser = require('./open-browser')
const StateConfig = require('./state-config')
const globalConfig = require('./global-config')
const chalkInstance = require('./chalk')
const resolveConfig = require('@netlify/config')
const { getAgent } = require('../lib/http-agent')
const argv = require('minimist')(process.argv.slice(2))
const { NETLIFY_AUTH_TOKEN, NETLIFY_API_URL } = process.env

// Netlify CLI client id. Lives in bot@netlify.com
// Todo setup client for multiple environments
const CLIENT_ID = 'd6f37de6614df7ae58664cfca524744d73807a377f5ee71f1a254f78412e3750'

const getToken = tokenFromFlag => {
  // 1. First honor command flag --auth
  if (tokenFromFlag) {
    return [tokenFromFlag, 'flag']
  }
  // 2. then Check ENV var
  if (NETLIFY_AUTH_TOKEN && NETLIFY_AUTH_TOKEN !== 'null') {
    return [NETLIFY_AUTH_TOKEN, 'env']
  }
  // 3. If no env var use global user setting
  const userId = globalConfig.get('userId')
  const tokenFromConfig = globalConfig.get(`users.${userId}.auth.token`)
  if (tokenFromConfig) {
    return [tokenFromConfig, 'config']
  }
  return [null, 'not found']
}

class BaseCommand extends Command {
  // Initialize context
  async init() {
    const cwd = argv.cwd || process.cwd()
    // Grab netlify API token
    const authViaFlag = getAuthArg(argv)

    const [token] = this.getConfigToken(authViaFlag)

    // Get site id & build state
    const state = new StateConfig(cwd)

    const cachedConfig = await this.getConfig(cwd, state, token, argv)
    const { configPath, config, buildDir } = cachedConfig

    const { flags } = this.parse(BaseCommand)
    const agent = await getAgent({
      log: this.log,
      exit: this.exit,
      httpProxy: flags.httpProxy,
      certificateFile: flags.httpProxyCertificateFilename,
    })
    const apiOpts = { agent }
    if (NETLIFY_API_URL) {
      const apiUrl = new URL(NETLIFY_API_URL)
      apiOpts.scheme = apiUrl.protocol.substring(0, apiUrl.protocol.length - 1)
      apiOpts.host = apiUrl.host
      apiOpts.pathPrefix = NETLIFY_API_URL === `${apiUrl.protocol}//${apiUrl.host}` ? '/api/v1' : apiUrl.pathname
    }

    this.netlify = {
      // api methods
      api: new API(token || '', apiOpts),
      // current site context
      site: {
        root: buildDir,
        configPath,
        get id() {
          return state.get('siteId')
        },
        set id(id) {
          state.set('siteId', id)
        },
      },
      // Configuration from netlify.[toml/yml]
      config,
      // Used to avoid calling @neltify/config again
      cachedConfig,
      // global cli config
      globalConfig,
      // state of current site dir
      state,
    }
  }

  // Find and resolve the Netlify configuration
  async getConfig(cwd, state, token, argv) {
    try {
      return await resolveConfig({
        config: argv.config,
        cwd,
        context: argv.context,
        debug: argv.debug,
        siteId: argv.siteId || (typeof argv.site === 'string' && argv.site) || state.get('siteId'),
        token,
        mode: 'cli',
      })
    } catch (error) {
      const message = error.type === 'userError' ? error.message : error.stack
      console.error(message)
      this.exit(1)
    }
  }

  async isLoggedIn() {
    try {
      await this.netlify.api.getCurrentUser()
      return true
    } catch (_) {
      return false
    }
  }

  logJson(message = '', ...args) {
    /* Only run json logger when --json flag present */
    if (!argv.json) {
      return
    }
    process.stdout.write(JSON.stringify(message, null, 2))
  }

  log(message = '', ...args) {
    /* If  --silent or --json flag passed disable logger */
    if (argv.silent || argv.json) {
      return
    }
    message = typeof message === 'string' ? message : inspect(message)
    process.stdout.write(format(message, ...args) + '\n')
  }

  /* Modified flag parser to support global --auth, --json, & --silent flags */
  parse(opts, argv = this.argv) {
    /* Set flags object for commands without flags */
    if (!opts.flags) {
      opts.flags = {}
    }
    /* enrich parse with global flags */
    const globalFlags = {}
    if (!opts.flags.silent) {
      globalFlags.silent = {
        parse: (b, _) => b,
        description: 'Silence CLI output',
        allowNo: false,
        type: 'boolean',
      }
    }
    if (!opts.flags.json) {
      globalFlags.json = {
        parse: (b, _) => b,
        description: 'Output return values as JSON',
        allowNo: false,
        type: 'boolean',
      }
    }
    if (!opts.flags.auth) {
      globalFlags.auth = {
        parse: (b, _) => b,
        description: 'Netlify auth token',
        input: [],
        multiple: false,
        type: 'option',
      }
    }

    // enrich with flags here
    opts.flags = Object.assign({}, opts.flags, globalFlags)

    return require('@oclif/parser').parse(
      argv,
      Object.assign(
        {},
        {
          context: this,
        },
        opts
      )
    )
  }

  get chalk() {
    // If --json flag disable chalk colors
    return chalkInstance(argv.json)
  }

  /**
   * Get user netlify API token
   * @param  {string} - [tokenFromFlag] - value passed in by CLI flag
   * @return {[string, string]} - tokenValue & location of resolved Netlify API token
   */
  getConfigToken(tokenFromFlag) {
    return getToken(tokenFromFlag)
  }

  authenticate(tokenFromFlag) {
    const [token] = this.getConfigToken(tokenFromFlag)
    if (!token) {
      return this.expensivelyAuthenticate()
    } else {
      return token
    }
  }

  async expensivelyAuthenticate() {
    const webUI = process.env.NETLIFY_WEB_UI || 'https://app.netlify.com'
    this.log(`Logging into your Netlify account...`)

    // Create ticket for auth
    const ticket = await this.netlify.api.createTicket({
      clientId: CLIENT_ID,
    })

    // Open browser for authentication
    const authLink = `${webUI}/authorize?response_type=ticket&ticket=${ticket.id}`

    this.log(`Opening ${authLink}`)
    await openBrowser({ url: authLink, log: this.log })

    const accessToken = await this.netlify.api.getAccessToken(ticket)

    if (!accessToken) {
      this.error('Could not retrieve access token')
    }

    const user = await this.netlify.api.getCurrentUser()
    const userID = user.id

    const userData = merge(this.netlify.globalConfig.get(`users.${userID}`), {
      id: userID,
      name: user.full_name,
      email: user.email,
      auth: {
        token: accessToken,
        github: {
          user: undefined,
          token: undefined,
        },
      },
    })
    // Set current userId
    this.netlify.globalConfig.set('userId', userID)
    // Set user data
    this.netlify.globalConfig.set(`users.${userID}`, userData)

    const email = user.email
    await identify({
      name: user.full_name,
      email,
    }).then(() => {
      return track('user_login', {
        email,
      })
    })

    // Log success
    this.log()
    this.log(`${this.chalk.greenBright('You are now logged into your Netlify account!')}`)
    this.log()
    this.log(`Run ${this.chalk.cyanBright('netlify status')} for account details`)
    this.log()
    this.log(`To see all available commands run: ${this.chalk.cyanBright('netlify help')}`)
    this.log()
    return accessToken
  }
}

function getAuthArg(cliArgs) {
  // If deploy command. Support shorthand 'a' flag
  if (cliArgs && cliArgs._ && cliArgs._[0] === 'deploy') {
    return cliArgs.auth || cliArgs.a
  }
  return cliArgs.auth
}

BaseCommand.strict = false
BaseCommand.flags = {
  debug: flags.boolean({
    description: 'Print debugging information',
  }),
  httpProxy: flags.string({
    description: 'Proxy server address to route requests through.',
    default: process.env.HTTP_PROXY || process.env.HTTPS_PROXY,
  }),
  httpProxyCertificateFilename: flags.string({
    description: 'Certificate file to use when connecting using a proxy server',
    default: process.env.NETLIFY_PROXY_CERTIFICATE_FILENAME,
  }),
}

BaseCommand.getToken = getToken
module.exports = BaseCommand
