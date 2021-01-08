const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const url = require('url');
const io = require('socket.io');
const Redis = require('ioredis');
const redisAdapter = require('socket.io-redis');
const bodyParser = require('body-parser');
const Pusher = require('pusher');
import { Log } from './log';
import { AppManager } from './app-managers/app-manager';

export class Server {
    /**
     * The http server.
     *
     * @type {any}
     */
    public express: any;

    /**
     * Socket.io client.
     *
     * @type {object}
     */
    public io: any;

    /**
     * The app manager used for client authentication.
     *
     * @type {AppManager}
     */
    protected _appManager;

    /**
     * Create a new server instance.
     *
     * @param {any} options
     */
    constructor(private options) {
        this._appManager = new AppManager(options);
    }

    /**
     * Initialize the server.
     *
     * @return {Promise<any>}
     */
    initialize(): Promise<any> {
        return new Promise((resolve, reject) => {
            this.serverProtocol().then(() => {
                let host = this.options.host || '127.0.0.1';
                Log.success(`Running at ${host} on port ${this.options.port}`);

                this.configureAdapters();

                resolve(this.io);
            }, error => reject(error));
        });
    }

    /**
     * Select the http protocol to run on.
     *
     * @return {Promise<any>}
     */
    serverProtocol(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.options.protocol === 'https') {
                this.configureSecurity().then(() => {
                    resolve(this.buildServer(true));
                }, error => reject(error));
            } else {
                resolve(this.buildServer(false));
            }
        });
    }

    /**
     * Load SSL 'key' & 'cert' files if https is enabled.
     *
     * @return {Promise<any>}
     */
    configureSecurity(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.options.ssl.certPath || !this.options.ssl.keyPath) {
                reject('SSL paths are missing in server config.');
            }

            Object.assign(this.options, {
                cert: fs.readFileSync(this.options.ssl.certPath),
                key: fs.readFileSync(this.options.ssl.keyPath),
                ca: (this.options.ssl.caPath) ? fs.readFileSync(this.options.ssl.caPath) : '',
                passphrase: this.options.ssl.passphrase,
            });

            resolve(this.options);
        });
    }

    /**
     * Create Socket.IO & HTTP(S) servers.
     *
     * @param  {boolean}  secure
     * @return {any}
     */
    buildServer(secure: boolean) {
        this.express = express();

        this.express.use((req, res, next) => {
            for (let header in this.options.headers) {
                res.setHeader(header, this.options.headers[header]);
            }

            next();
        });

        this.express.use(bodyParser.json());

        let httpServer = secure
            ? https.createServer(this.options, this.express)
            : http.createServer(this.express);

        httpServer.listen(this.options.port, this.options.host);

        this.authorizeRequests();

        this.options.socketIoOptions = {
            ...this.options.socketIoOptions,
            ...{
                cors: this.options.cors,
            },
        };

        return this.io = io(httpServer, this.options.socketIoOptions);
    }

    /**
     * Configure the Socket.IO adapters.
     *
     * @return {void}
     */
    configureAdapters(): void {
        if (this.options.database.driver === 'redis') {
            let pubClient = new Redis(this.options.database.redis);
            let subClient = new Redis(this.options.database.redis);

            this.io.adapter(redisAdapter({
                key: 'redis-adapter',
                pubClient: pubClient,
                subClient: subClient,
            }));
        }
    }

    /**
     * Attach global protection to HTTP routes, to verify the API key.
     */
    authorizeRequests(): void {
        this.express.param('appId', (req, res, next) => {
            if (!this.canAccess(req)) {
                return this.unauthorizedResponse(req, res);
            }

            next();
        });
    }

    /**
     * Check is an incoming request can access the api.
     *
     * @param  {any}  req
     * @return {boolean}
     */
    canAccess(req: any): boolean {
        let app = this._appManager.find(this.getAppId(req));

        if (! app) {
            return false;
        }

        let key = req.query.auth_key;
        let signature = req.query.auth_signature;
        let timestamp = req.query.timestamp;
        let version = req.query.auth_version ? req.query.auth_version : '1.0';
        let bodyMD5 = req.query.body_md5;

        const pusher = new Pusher({
            appId: app.id,
            key: app.key,
            secret: app.secret,
        });

        // console.log({
        //     query: req.query,
        //     params: req.params,
        //     body: req.body,
        //     expectedQuery: pusher.createSignedQueryString(req),
        // });

        return true;
    }

    /**
     * Get the app ID from the URL.
     *
     * @param  {any}  req
     * @return {string|null}
     */
    getAppId(req: any): string|null {
        return req.params.appId ? req.params.appId : null;
    }

    /**
     * Handle unauthorized requests.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {boolean}
     */
    unauthorizedResponse(req: any, res: any): boolean {
        res.statusCode = 403;
        res.json({ error: 'Unauthorized' });

        return false;
    }
}
