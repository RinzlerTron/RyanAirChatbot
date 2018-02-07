'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const conversation = require('./lib/conversation');

const app = express();

app.use(express.static('./public'));
app.use(bodyParser.json());

// Endpoint to be call from the client side
app.post('/api/message', function (req, res) {
    conversation.context(req.body.context);
    conversation.send(req.body.input, function(err, response) {
        if(err) {
            return res.status(err.code || 500).json(err);
        }
        return res.json(response);
    });
});



module.exports = app;