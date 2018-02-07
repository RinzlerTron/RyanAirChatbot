'use strict'

const fs = require('fs');
const buildUrl = require('build-url');
const axios = require('axios');
const Watson = require('watson-developer-cloud');

class Conversation {
    static get ENTITIES() {
        return {
            LOCATION: 'sys-location',
            AIRPORT: 'airport',
            FLIGHT: 'flight'
        }
    }

    static get INTENTS() {
        return {
            AIPORT_CODE: 'airport-code',
            FLIGHT_STATUS: 'flight-status',
            AIRPORT_STATUS: 'airport-status',
            AIRPORT_DISTANCE: 'airport-distance',
            TIME_TO: 'time-to-airport'
        }
    }

    static get VARS() {
        return {
            AIRPORT: 'airport',
            LOCATION: 'location',
            FLIGHT: 'flight',
            CURRENT_LOCATION: 'current_location'
        }
    }

    fetchLocation(callback) {
        navigator.geolocation.getCurrentPosition(callback);
    }

    api(path, params = {}) {
        params.apikey = this.apikey;
        return axios.get(buildUrl('http://apigateway.ryanair.com/pub/v1', {
            path: path.replace(/^\s*\//, ''),
            queryParams: params
        }));
    }

    gapi(type, path, params = {}) {
        params.key = this.gapikey;
        return axios.get(buildUrl('https://maps.googleapis.com/'+type+'/api', {
            path: path.replace(/^\s*\//, '').replace(/\/\s*$/, '')+'/json',
            queryParams: params
        }));
    }

    constructor() {
        this.apikey = process.env.RYANAIR_KEY;
        this.gapikey = process.env.GOOGLE_KEY;
        this.workspace_id = process.env.WORKSPACE_ID;
        this.conversation_context = {};
        this.conversation = new Watson.ConversationV1({
            'version_date': '2017-05-26'
        });
        // find
        this.flights = [];
        this.api('core/3/cities').then(r => {
            this.cities = r.data;
        });
        this.api('core/3/airports').then(r => {
            this.airports = r.data;
            // map airports to ibm app
            this.conversation.updateEntity({
                workspace_id: this.workspace_id,
                entity: 'airport',
                new_values: this.airports.map(a => {
                    return {
                        value: a.iataCode,
                        synonyms: [a.iataCode.toLowerCase()],
                        value_type: ['synonyms']
                    }
                })
            });
        });
    }

    responseHasIntent(response, intentType) {
        return response.intents.some(int => int.intent==intentType&&int.confidence>0.6);
    }

    responseHasEntity(response, entityType) {
        return response.entities.some(ent => ent.entity==entityType&&ent.confidence>0.6);
    }

    responseHasContext(response, contextVariable) {
        return response.context.hasOwnProperty(contextVariable)&&response.context[contextVariable]!='';
    }

    parseFlightInfo(info) {
        return 'Your flight RYR'+info.number+' will depart from '+
                    info.departureAirport.iataCode+' at '+
                    (info.departureTime.actual!=undefined ? info.departureTime.actual : info.departureTime.estimated)+' and arrive on '+
                    info.arrivalAirport.iataCode+' at '+
                    (info.arrivalTime.actual!=undefined ? info.arrivalTime.actual : info.arrivalTime.estimated)+'. Your flight is currently '+
                    info.status.message
    }

    context(ctx) {
        this.conversation_context = ctx;
    }

    parse(input, response, callback) {
        // fallback
        if (!response.output) {
            response.output = {
                text: 'Didn\'t quite get that'
            };
            return response;
        }
        const context = response.context;
        // check dialog node
        console.log(response);
        if(this.responseHasEntity(response, Conversation.ENTITIES.LOCATION)&&
            this.responseHasContext(response, Conversation.VARS.AIRPORT)&&
            this.responseHasContext(response, Conversation.VARS.LOCATION)) {
            // find city
            const city = this.cities.find(c => c.name.toLowerCase()==context.location.toLowerCase());
            if(!city) {
                response.output.text.push('We don\'t fly to '+context.location+' sorry :(');
                return callback(response);
            }
            // get dest airport code
            const airports = this.airports.filter(a => a.cityCode==city.code);
            if(airports.length==0) {
                response.output.text.push('We don\'t fly to '+context.location+' sorry :(');
                return callback(response);
            }
            const airportCodes = airports.map(a => a.iataCode);
            // find info
            this.api('flightinfo/3/flights', {
                departureAirportIataCode: context.airport
            }).then(r => {
                const flights = r.data.flights.filter(f => airportCodes.indexOf(f.arrivalAirport.iataCode)!==-1);
                if(flights.length==0) {
                    response.output.text.push('We aren\'t flying from '+context.airport+' to '+context.location+' today :/');
                } else {
                    this.flights = flights;
                    response.output.text.push('Please confirm your flight number');
                    response.output.text.push(flights.map(f => 'RYR'+f.number).join('<br />'));
                }
                return callback(response);
            });
        } else if(this.responseHasEntity(response, Conversation.ENTITIES.FLIGHT)) {
            const flight = response.entities.find(e => e.entity==Conversation.ENTITIES.FLIGHT);
            const number = response.input.text.substring(flight.groups[1].location[0], flight.groups[1].location[1]).replace('RYR', '');
            context.flight = number;
            this.context(context);
            // get info
            this.api('flightinfo/3/flights', {
                number: number
            }).then(r => {
                const flight = r.data.flights;
                if(flight.length > 0) {
                    response.output.text.push('Here\'s some info');
                    response.output.text.push(this.parseFlightInfo(flight[0]));
                } else {
                    response.output.text.push('Oops, we couldn\'t find your flight');
                }
                return callback(response);
            });
        } else if(this.responseHasIntent(response, Conversation.INTENTS.FLIGHT_STATUS)&&
                    this.responseHasContext(response, Conversation.VARS.FLIGHT)&&
                    context.flight!='flightNumber') {
            this.api('flightinfo/3/flights', {
                number: response.context.flight
            }).then(r => {
                const flight = r.data.flights;
                if(flight.length > 0) {
                    response.output.text.push('Here\'s some info');
                    response.output.text.push(this.parseFlightInfo(flight[0]));
                } else {
                    response.output.text.push('Oops, we couldn\'t find your flight');
                }
                return callback(response);
            });
        } else if(this.responseHasIntent(response, Conversation.INTENTS.AIRPORT_STATUS)&&
                    this.responseHasContext(response, Conversation.VARS.AIRPORT)) {
            const airport = this.airports.find(a => a.iataCode.toUpperCase()==context.airport.toUpperCase());
            if(airport) {
                this.api('aggregate/3/common', {
                    embedded: 'closures',
                    latitude: airport.coordinates.latitude,
                    longitude: airport.coordinates.longitude,
                    nearbyAirportsLimit: 1
                }).then(r => {
                    const closures = r.data.closures;
                    if(closures.length==0) {
                        response.output.text = ['There are no closures for '+airport.iataCode];
                    } else {
                        response.output.text = ['Please advise there is closure for '+airport.iataCode];
                    }
                    return callback(response);
                });
            }
        } else if(this.responseHasIntent(response, Conversation.INTENTS.AIRPORT_DISTANCE)) {
            if(!this.responseHasContext(response, Conversation.VARS.CURRENT_LOCATION)) {
                // send a location request
                response.requestLocation = true;
                return callback(response);
            } else {
                const airport = this.airports.find(a => a.iataCode.toUpperCase()==context.airport.toUpperCase());
                this.gapi('maps', 'distancematrix', {
                    origins: context.current_location.latitude+','+context.current_location.longitude,
                    destinations: airport.coordinates.latitude+','+airport.coordinates.longitude
                }).then(r => {
                    response.output.text.push('It is '+r.data.rows[0].elements[0].distance.text+' to '+airport.iataCode);
                    return callback(response);
                });
            }
        } else if(this.responseHasIntent(response, Conversation.INTENTS.TIME_TO)) {
            // check for flight distance
            if(!this.responseHasContext(response, Conversation.VARS.CURRENT_LOCATION)) {
                response.requestLocation = true;
                return callback(response);
            } else {
                const airport = this.airports.find(a => a.iataCode.toUpperCase()==context.airport.toUpperCase());
                this.gapi('maps', 'distancematrix', {
                    origins: context.current_location.latitude+','+context.current_location.longitude,
                    destinations: airport.coordinates.latitude+','+airport.coordinates.longitude
                }).then(r => {
                    response.output.text.push('It\'s a '+r.data.rows[0].elements[0].duration.text+' drive to '+airport.iataCode);
                    return callback(response);
                });
            }
        } else {
            return callback(response);
        }
    }

    prepare(input) {
        const context = this.conversation_context;
        return {
            workspace_id: this.workspace_id,
            context: context,
            input: input
        };
    }

    send(input, callback) {
        const payload = this.prepare(input);
        this.conversation.message(payload, (err, data) => {
            if(err) {
                return callback(err);
            }
            return this.parse(payload, data, resp => {
                return callback(null, resp);
            });
        });
    }
}

module.exports = new Conversation();