import { IpcPacketNet } from 'socket-serializer';
import { IpcPacketBuffer } from 'socket-serializer';

import * as IpcBusInterfaces from './IpcBusInterfaces';
import * as IpcBusUtils from './IpcBusUtils';
// import * as util from 'util';

import { IpcBusCommonClient } from './IpcBusClient';
import { IpcBusTransport } from './IpcBusTransport';
import { IpcBusCommand } from './IpcBusCommand';
import { IpcBusTransportNode } from './IpcBusTransportNode';

/** @internal */
export class IpcBusBrokerImpl implements IpcBusInterfaces.IpcBusBroker {
    private _baseIpc: IpcPacketNet;
    private _ipcServer: any = null;
    private _ipcOptions: IpcBusUtils.IpcOptions;
    private _ipcBusBrokerClient: IpcBusCommonClient;

    private _promiseStarted: Promise<string>;

    private _subscriptions: IpcBusUtils.ChannelConnectionMap<string>;
    private _requestChannels: Map<string, any>;
    private _ipcBusPeers: Map<string, IpcBusInterfaces.IpcBusPeer>;

    private _queryStateLamdba: IpcBusInterfaces.IpcBusListener = (ipcBusEvent: IpcBusInterfaces.IpcBusEvent, replyChannel: string) => this._onQueryState(ipcBusEvent, replyChannel);
    private _serviceAvailableLambda: IpcBusInterfaces.IpcBusListener = (ipcBusEvent: IpcBusInterfaces.IpcBusEvent, serviceName: string) => this._onServiceAvailable(ipcBusEvent, serviceName);

    constructor(processType: IpcBusInterfaces.IpcBusProcessType, ipcOptions: IpcBusUtils.IpcOptions) {
        this._ipcOptions = ipcOptions;

        this._subscriptions = new IpcBusUtils.ChannelConnectionMap<string>('IPCBus:Broker');
        this._requestChannels = new Map<string, any>();
        this._ipcBusPeers = new Map<string, IpcBusInterfaces.IpcBusPeer>();

        let ipcBusTransport: IpcBusTransport = new IpcBusTransportNode(processType, ipcOptions);
        this._ipcBusBrokerClient = new IpcBusCommonClient(ipcBusTransport);
    }

    private _reset() {
        this._promiseStarted = null;
        if (this._baseIpc) {
            this._baseIpc.removeAllListeners();
            this._baseIpc = null;
        }

        if (this._ipcServer) {
            this._ipcBusBrokerClient.close();
            this._ipcServer.close();
            this._ipcServer = null;
        }
    }

    // IpcBusBroker API
    start(options?: IpcBusInterfaces.IpcBusBroker.StartOptions): Promise<string> {
        options = options || {};
        if (options.timeoutDelay == null) {
            options.timeoutDelay = IpcBusUtils.IPC_BUS_TIMEOUT;
        }
        // Store in a local variable, in case it is set to null (paranoid code as it is asynchronous!)
        let p = this._promiseStarted;
        if (!p) {
            p = this._promiseStarted = new Promise<string>((resolve, reject) => {
                let timer: NodeJS.Timer;
                // Below zero = infinite
                if (options.timeoutDelay >= 0) {
                    timer = setTimeout(() => {
                        this._reset();
                        let msg = `[IPCBus:Broker] error = timeout (${options.timeoutDelay} ms) on ${JSON.stringify(this._ipcOptions)}`;
                        IpcBusUtils.Logger.enable && IpcBusUtils.Logger.error(msg);
                        reject(msg);
                    }, options.timeoutDelay);
                }
                this._baseIpc = new IpcPacketNet();
                this._baseIpc.once('listening', (server: any) => {
                    this._ipcServer = server;
                    if (this._baseIpc) {
                        this._baseIpc.removeAllListeners('error');
                        IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info(`[IPCBus:Broker] Listening for incoming connections on ${JSON.stringify(this._ipcOptions)}`);
                        clearTimeout(timer);
                        this._baseIpc.on('connection', (socket: any, server: any) => this._onConnection(socket, server));
                        this._baseIpc.on('close', (err: any, socket: any, server: any) => this._onClose(err, socket, server));
                        this._baseIpc.on('packet', (buffer: any, socket: any, server: any) => this._onData(buffer, socket, server));

                        this._ipcBusBrokerClient.connect({ peerName: `IpcBusBrokerClient` })
                            .then(() => {
                                this._ipcBusBrokerClient.on(IpcBusInterfaces.IPCBUS_CHANNEL_QUERY_STATE, this._queryStateLamdba);
                                this._ipcBusBrokerClient.on(IpcBusInterfaces.IPCBUS_CHANNEL_SERVICE_AVAILABLE, this._serviceAvailableLambda);
                                resolve('started');
                            })
                            .catch((err) => {
                                this._reset();
                                let msg = `[IPCBus:Broker] error = ${err}`;
                                IpcBusUtils.Logger.enable && IpcBusUtils.Logger.error(msg);
                                reject(msg);
                            });
                    }
                    else {
                        this._reset();
                    }
                });
                this._baseIpc.once('error', (err: any) => {
                    let msg = `[IPCBus:Broker] error = ${err} on ${JSON.stringify(this._ipcOptions)}`;
                    IpcBusUtils.Logger.enable && IpcBusUtils.Logger.error(msg);
                    clearTimeout(timer);
                    this._reset();
                    reject(msg);
                });
                this._baseIpc.listen(this._ipcOptions.port, this._ipcOptions.host);
            });
        }
        return p;
    }

    stop(options?: IpcBusInterfaces.IpcBusBroker.StopOptions): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this._ipcServer) {
                let timer: NodeJS.Timer;
                // Below zero = infinite
                if (options.timeoutDelay >= 0) {
                    timer = setTimeout(() => {
                        let msg = `[IPCBus:Broker] stop, error = timeout (${options.timeoutDelay} ms) on ${JSON.stringify(this._ipcOptions)}`;
                        IpcBusUtils.Logger.enable && IpcBusUtils.Logger.error(msg);
                        reject(msg);
                    }, options.timeoutDelay);
                }
                this._ipcServer.on('close', (conn: any) => {
                    clearTimeout(timer);
                    resolve();
                });
                this._ipcServer.on('error', (conn: any) => {
                    clearTimeout(timer);
                    resolve();
                });
                this._reset();
            }
            else {
                resolve();
            }
        });
    }

    queryState(): Object {
        let queryStateResult: Object[] = [];
        this._subscriptions.forEach((connData, channel) => {
            connData.peerIds.forEach((peerIdRefCount) => {
                queryStateResult.push({ channel: channel, peer: this._ipcBusPeers.get(peerIdRefCount.peerId), count: peerIdRefCount.refCount });
            });
        });
        return queryStateResult;
    }

    isServiceAvailable(serviceName: string): boolean {
        return this._subscriptions.hasChannel(IpcBusUtils.getServiceCallChannel(serviceName));
    }

    protected _onQueryState(ipcBusEvent: IpcBusInterfaces.IpcBusEvent, replyChannel: string) {
        const queryState = this.queryState();
        if (ipcBusEvent.request) {
            ipcBusEvent.request.resolve(queryState);
        }
        else if (replyChannel != null) {
            this._ipcBusBrokerClient.send(replyChannel, queryState);
        }
    }

    protected _onServiceAvailable(ipcBusEvent: IpcBusInterfaces.IpcBusEvent, serviceName: string) {
        const availability = this.isServiceAvailable(serviceName);
        IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info(`[IPCBus:Broker] Service '${serviceName}' availability : ${availability}`);
        if (ipcBusEvent.request) {
            ipcBusEvent.request.resolve(availability);
        }
    }

    protected _onConnection(socket: any, server: any): void {
        IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info(`[IPCBus:Broker] Incoming connection !`);
        // IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info('[IPCBus:Broker] socket.address=' + JSON.stringify(socket.address()));
        // IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info('[IPCBus:Broker] socket.localAddress=' + socket.localAddress);
        // IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info('[IPCBus:Broker] socket.remoteAddress=' + socket.remoteAddress);
        IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info('[IPCBus:Broker] socket.remotePort=' + socket.remotePort);
        socket.on('error', (err: string) => {
            IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info(`[IPCBus:Broker] Error on connection: ${err}`);
        });
    }

    protected _socketCleanUp(socket: any): void {
        this._subscriptions.releaseConnection(socket.remotePort);
        // ForEach is supposed to support deletion during the iteration !
        this._requestChannels.forEach((socketForRequest, channel) => {
            if (socketForRequest.remotePort === socket.remotePort) {
                this._requestChannels.delete(channel);
            }
        });
        IpcBusUtils.Logger.enable && IpcBusUtils.Logger.info(`[IPCBus:Broker] Connection closed !`);
    }

    protected _onClose(err: any, socket: any, server: any): void {
        this._socketCleanUp(socket);
    }

    protected _onData(packet: IpcPacketBuffer, socket: any, server: any): void {
        let ipcBusCommand: IpcBusCommand = packet.parseArrayAt(0);
        switch (ipcBusCommand.kind) {
            case IpcBusCommand.Kind.Connect:
                this._ipcBusPeers.set(ipcBusCommand.peer.id, ipcBusCommand.peer);
                break;

            case IpcBusCommand.Kind.Disconnect:
                if (this._ipcBusPeers.delete(ipcBusCommand.peer.id)) {
                    this._subscriptions.releasePeerId(socket.remotePort, ipcBusCommand.peer.id);
                }
                break;

            case IpcBusCommand.Kind.Close:
                this._socketCleanUp(socket);
                break;

            case IpcBusCommand.Kind.AddChannelListener:
                this._subscriptions.addRef(ipcBusCommand.channel, socket.remotePort, socket, ipcBusCommand.peer.id);
                break;

            case IpcBusCommand.Kind.RemoveChannelAllListeners:
                this._subscriptions.releaseAll(ipcBusCommand.channel, socket.remotePort, ipcBusCommand.peer.id);
                break;

            case IpcBusCommand.Kind.RemoveChannelListener:
                this._subscriptions.release(ipcBusCommand.channel, socket.remotePort, ipcBusCommand.peer.id);
                break;

            case IpcBusCommand.Kind.RemoveListeners:
                this._subscriptions.releasePeerId(socket.remotePort, ipcBusCommand.peer.id);
                break;

            case IpcBusCommand.Kind.SendMessage:
                // Send ipcBusCommand to subscribed connections
                this._subscriptions.forEachChannel(ipcBusCommand.channel, (connData, channel) => {
                    connData.conn.write(packet.buffer);
                });
                break;

            case IpcBusCommand.Kind.RequestMessage:
                // Register on the replyChannel
                this._requestChannels.set(ipcBusCommand.request.replyChannel, socket);

                // Request ipcBusCommand to subscribed connections
                this._subscriptions.forEachChannel(ipcBusCommand.channel, (connData, channel) => {
                    connData.conn.write(packet.buffer);
                });
                break;

            case IpcBusCommand.Kind.RequestResponse: {
                let replySocket = this._requestChannels.get(ipcBusCommand.request.replyChannel);
                if (replySocket) {
                    this._requestChannels.delete(ipcBusCommand.request.replyChannel);
                    // Send ipcBusCommand to subscribed connections
                    replySocket.write(packet.buffer);
                }
                break;
            }

            case IpcBusCommand.Kind.RequestCancel:
                this._requestChannels.delete(ipcBusCommand.request.replyChannel);
                break;

            default:
                console.log(JSON.stringify(ipcBusCommand, null, 4));
                throw 'IpcBusBrokerImpl: Not valid packet !';
        }
    }
}
