import { Log } from './../log';
let url = require('url');
import * as _ from 'lodash';

export class HttpApi {
    /**
     * Create new instance of http subscriber.
     *
     * @param {any} io
     * @param {any} channel
     * @param {any} express
     * @param {object} options
     */
    constructor(private io, private channel, private express, private options) {
        //
    }

    /**
     * Initialize the API.
     */
    init(): void {
        this.corsMiddleware();

        // this.express.get('/', (req, res) => this.getRoot(req, res));
        // this.express.get('/apps/:appId/channels', (req, res) => this.getChannels(req, res));
        // this.express.get('/apps/:appId/channels/:channelName', (req, res) => this.getChannel(req, res));
        // this.express.get('/apps/:appId/channels/:channelName/users', (req, res) => this.getChannelUsers(req, res));
    }

    /**
     * Add CORS middleware if applicable.
     */
    corsMiddleware(): void {
        this.express.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', this.options.origin.join(', '));
            res.header('Access-Control-Allow-Methods', this.options.methods.join(', '));
            res.header('Access-Control-Allow-Headers', this.options.allowedHeaders.join(', '));

            next();
        });
    }

    /**
     * Outputs a simple message to show that the server is running.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {void}
     */
    getRoot(req: any, res: any): void {
        res.send('OK');
    }

    /**
     * Get a list of the open channels on the server.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {void}
     */
    getChannels(req: any, res: any): void {
        let prefix = url.parse(req.url, true).query.filter_by_prefix;
        let rooms = this.io.sockets.adapter.rooms;
        let channels = {};

        Object.keys(rooms).forEach(function(channelName) {
            if (rooms[channelName].sockets[channelName]) {
                return;
            }

            if (prefix && !channelName.startsWith(prefix)) {
                return;
            }

            channels[channelName] = {
                subscription_count: rooms[channelName].length,
                occupied: true
            };
        });

        res.json({ channels: channels });
    }

    /**
     * Get a information about a channel.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {void}
     */
    getChannel(req: any, res: any): void {
        let channelName = req.params.channelName;
        let room = this.io.sockets.adapter.rooms[channelName];
        let subscriptionCount = room ? room.length : 0;

        let result = {
            subscription_count: subscriptionCount,
            occupied: !!subscriptionCount
        };

        if (this.channel.isPresence(channelName)) {
            this.channel.presence.getMembers(channelName).then(members => {
                result['user_count'] = _.uniqBy(members, 'user_id').length;

                res.json(result);
            });
        } else {
            res.json(result);
        }
    }

    /**
     * Get the users of a channel.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @return {boolean}
     */
    getChannelUsers(req: any, res: any): boolean {
        let channelName = req.params.channelName;

        if (!this.channel.isPresence(channelName)) {
            return this.badResponse(
                req,
                res,
                'User list is only possible for Presence Channels'
            );
        }

        this.channel.presence.getMembers(channelName).then(members => {
            let users = [];

            _.uniqBy(members, 'user_id').forEach((member: any) => {
                users.push({ id: member.user_id, user_info: member.user_info });
            });

            res.json({ users: users });
        }, error => Log.error(error));
    }

    /**
     * Handle bad requests.
     *
     * @param  {any}  req
     * @param  {any}  res
     * @param  {string}  message
     * @return {boolean}
     */
    badResponse(req: any, res: any, message: string): boolean {
        res.statusCode = 400;
        res.json({ error: message });

        return false;
    }
}
