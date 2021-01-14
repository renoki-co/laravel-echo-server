import { Log } from './../log';
import { PresenceChannel } from './../channels/presence-channel';

const pusherUtil = require('pusher/lib/util');
const Pusher = require('pusher');
const url = require('url');

export class HttpApi {
    /**
     * Create new instance of HTTP API.
     *
     * @param {any} server
     * @param {any}  io
     * @param {any} express
     * @param {object} options
     * @param {any}  appManager
     */
    constructor(
        protected server,
        protected io,
        protected express,
        protected options,
        protected appManager
    ) {
        //
    }

    /**
     * Initialize the HTTP API.
     *
     * @return {void}
     */
    initialize(): void {
        this.registerCorsMiddleware();
        this.configurePusherAuthentication();

        this.express.get('/', (req, res) => this.getRoot(req, res));
        this.express.get('/apps/:appId/channels', (req, res) => this.getChannels(req, res));
        this.express.get('/apps/:appId/channels/:channelName', (req, res) => this.getChannel(req, res));
        this.express.get('/apps/:appId/channels/:channelName/users', (req, res) => this.getChannelUsers(req, res));
        this.express.post('/apps/:appId/events', (req, res) => this.broadcastEvent(req, res));
    }

    /**
     * Add CORS middleware if applicable.
     *
     * @return {void}
     */
    protected registerCorsMiddleware(): void {
        this.express.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', this.options.cors.origin.join(', '));
            res.header('Access-Control-Allow-Methods', this.options.cors.methods.join(', '));
            res.header('Access-Control-Allow-Headers', this.options.cors.allowedHeaders.join(', '));

            next();
        });
    }

    /**
     * Attach global protection to HTTP routes, to verify the API key.
     *
     * @return {void}
     */
    protected configurePusherAuthentication(): void {
        this.express.param('appId', (req, res, next) => {
            this.signatureIsValid(req).then(isValid => {
                if (!isValid) {
                    this.unauthorizedResponse(req, res);
                } else {
                    next()
                }
            });
        });
    }

    /**
     * Outputs a simple message to show that the server is running.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {void}
     */
    protected getRoot(req: any, res: any): void {
        res.send('OK');
    }

    /**
     * Get a list of the open channels on the server.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {void}
     */
    protected getChannels(req: any, res: any): void {
        let appId = this.getAppId(req);
        let prefix = url.parse(req.url, true).query.filter_by_prefix;
        let rooms = this.io.of(`/${appId}`).adapter.rooms;
        let channels = {};

        rooms.forEach((sockets, channelName) => {
            if (sockets.size === 0) {
                return;
            }

            if (prefix && !channelName.startsWith(prefix)) {
                return;
            }

            channels[channelName] = {
                subscription_count: sockets.size,
                occupied: true
            };
        }, []);

        res.json({ channels: channels });
    }

    /**
     * Get a information about a channel.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {void}
     */
    protected getChannel(req: any, res: any): void {
        let appId = this.getAppId(req);
        let channelName = req.params.channelName;
        let room = this.io.of(`/${appId}`).adapter.rooms.get(channelName);
        let subscriptionCount = room ? room.size : 0;
        let channel = this.server.getChannelInstance(channelName);

        let result = {
            subscription_count: subscriptionCount,
            occupied: !!subscriptionCount
        };

        if (channel instanceof PresenceChannel) {
            channel.getMembers(`/${appId}`, channelName).then(members => {
                members = members || [];

                res.json({
                    ...result,
                    ...{
                        user_count: members.reduce((map, member) => map.set(member.user_id, member), new Map).size
                    },
                });
            });
        } else {
            res.json({ result });
        }
    }

    /**
     * Get the users of a channel.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {boolean}
     */
    protected getChannelUsers(req: any, res: any): boolean {
        let appId = this.getAppId(req);
        let channelName = req.params.channelName;
        let channel = this.server.getChannelInstance(channelName);

        if (!(channel instanceof PresenceChannel)) {
            return this.badResponse(
                req,
                res,
                'User list is only possible for Presence Channels'
            );
        }

        channel.getMembers(`/${appId}`, channelName).then(members => {
            members = members || [];

            res.json({
                users: [...members.reduce((map, member) => map.set(member), new Map)][0].filter(user => !!user),
            });
        }, error => Log.error(error));
    }

    /**
     * Broadcast an event.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {boolean}
     */
    protected broadcastEvent(req: any, res: any): boolean {
        if (
            (!req.body.channels && !req.body.channel) ||
            !req.body.name ||
            !req.body.data
        ) {
            return this.badResponse(req, res, 'Wrong format.');
        }

        let appId = this.getAppId(req);
        let channels = req.body.channels || [req.body.channel];

        channels.forEach(channel => {
            this.io.of(`/${appId}`)
                .to(channel)
                .emit(req.body.name, channel, req.body.data);
        });

        res.json({ message: 'ok' });

        return true;
    }

    /**
     * Get the app ID from the URL.
     *
     * @param  {any}  req
     * @return {string|null}
     */
    protected getAppId(req: any): string|null {
        return req.params.appId ? req.params.appId : null;
    }

    /**
     * Check is an incoming request can access the api.
     *
     * @param  {any}  req
     * @return {Promise<boolean>}
     */
    protected signatureIsValid(req: any): Promise<boolean> {
        return new Promise((resolve, reject) => {
            this.getSignedToken(req).then(token => {
                resolve(token === req.query.auth_signature);
            });
        });
    }

    /**
     * Get the signed token from the given request.
     *
     * @param  {any}  req
     * @return {Promise<string>}
     */
    protected getSignedToken(req: any): Promise<string> {
        return new Promise((resolve, reject) => {
            let socketData = {
                auth: {
                    headers: req.headers,
                },
            };

            this.appManager.find(this.getAppId(req), null, socketData).then(app => {
                if (!app) {
                    reject({ reason: 'App not found when signing token.' });
                }

                let key = req.query.auth_key;
                let token = new Pusher.Token(key, app.secret);

                const params = {
                    auth_key: app.key,
                    auth_timestamp: req.query.auth_timestamp,
                    auth_version: req.query.auth_version,
                    ...req.query,
                    ...req.params,
                };

                delete params['auth_signature'];
                delete params['body_md5']
                delete params['appId'];
                delete params['appKey'];
                delete params['channelName'];

                if (req.body && Object.keys(req.body).length > 0) {
                    params['body_md5'] = pusherUtil.getMD5(JSON.stringify(req.body));
                }

                resolve(
                    token.sign([
                        req.method.toUpperCase(),
                        req.path,
                        pusherUtil.toOrderedArray(params).join('&'),
                    ].join("\n"))
                );
            }, error => {
                Log.error({
                    time: new Date().toISOString(),
                    action: 'find_app',
                    status: 'failed',
                    error,
                });
            });
        });
    }

    /**
     * Handle bad requests.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @param  {string}  message
     * @return {boolean}
     */
    protected badResponse(req: any, res: any, message: string): boolean {
        res.statusCode = 400;
        res.json({ error: message });

        return false;
    }

    /**
     * Handle unauthorized requests.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {boolean}
     */
    protected unauthorizedResponse(req: any, res: any): boolean {
        if (this.options.development) {
            Log.error({
                time: new Date().toISOString(),
                action: 'pusher_auth',
                status: 'failed',
                params: req.params,
                query: req.query,
                body: req.body,
                signedToken: this.getSignedToken(req),
                givenToken: req.query.auth_signature,
            });
        }

        res.statusCode = 403;
        res.json({ error: 'Unauthorized' });

        return false;
    }
}
