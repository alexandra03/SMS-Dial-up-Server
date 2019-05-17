var express = require('express');
var request = require('request');
var cheerio = require('cheerio');
var _ = require('underscore');
var sanitizeHtml = require('sanitize-html');
var bodyParser = require('body-parser');

if (process.env.NODE_ENV !== 'production') {
	require('dotenv').config();
}

var redis = require('redis');
var redisClient = redis.createClient(process.env.REDIS_URL); 

var twilioClient = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

var app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
	extended: true
}));

/* 
	Constants for minifying the HTML
*/
const shortenedExpressions = {
	'the': 't',
	'and': '&',
	'that': 'h',
	'with': 'w',
};

const shortenedHTML = {
	'<input': 'Ξ',
	'<a href="': 'Φ',
	'</a>': 'Ω',
	'<form>': 'Ψ',
	'</form>': 'Θ',
	'">': 'Σ',
	'>': 'Π',
	'="submit" ': 'Γ',
	'="hidden" ': 'ß',
	'name="': 'æ',
	'type="': 'Δ',
	'value="': '_'
};

const urlsWeDontWant = [
	'policies', 'signin', 'preferences',
	'login', 'signout'
];


/* 
	Helper functions
*/
const shortenText = (text) => {
	if (text) {
		_.mapObject(shortenedExpressions, (word, short) => {
			text = text.replace(`/${word}/ig`, short);
		});
	}
	return text;
};

const urlToSymbol = (msgId, url) => {
	if (url && _.every(urlsWeDontWant, (notNecessary) => url.indexOf(notNecessary) < 0)) {
		var urlPlaceholder = Math.random().toString(36).substr(2, 3);
		redisClient.set(`${msgId}_${urlPlaceholder}`, url);
		return urlPlaceholder;
	}
	return '';
};

const transformTags = (msgId) => {
	return {
		'a': (tagName, attribs) => {
			return {
				tagName: tagName,
				text: shortenText(attribs.text),
				attribs: {
					href: urlToSymbol(msgId, attribs.href)
				}
			}
		},
		'input': (tagName, attribs) => {
			var newAttribs = {
				type: attribs.type || 'text'
			};
			if (attribs.type == 'submit') {
				newAttribs.value = shortenText(attribs.value);
			} else {
				newAttribs.name = attribs.name;
			}
			return {
				tagName: tagName,
				attribs: newAttribs
			}
		}
	}
};


/* 
	App time!!
*/
app.get('', (req, res) => {
	res.send('Hello!');
});

app.all('/get', (req, res) => {
	const url = `https://${req.body.Body}`;
	const msgId = req.body.MessageSid;

	request(url, (error, response, html) => {
		if (error) return;

		try {
			var $ = cheerio.load(html);  // Load HTML to extract the body like we would in jQuery

			// Get rid of all the tags and attributes we don't want
			var clean = sanitizeHtml($('body').html(), {
				allowedTags: ['a', 'input', 'form'],
				transformTags: transformTags(msgId),
				textFilter: shortenText,
				allowedAttributes: {
					input: ['value', 'type', 'name'],
					a: ['href']
				},
				exclusiveFilter: (frame) => {
					// Ignore hidden inputs and anchors that go nowhere
					return (frame.tag === 'input' && frame.attribs.type === 'hidden') ||
						(frame.tag === 'a' && frame.attribs && !frame.attribs.href);
				},
			});

			// Eliminate all spaces between elements
			clean = clean.replace(new RegExp('\>[ ]+\<', 'g'), '><'); 

			// Minify all the remaining tags and attributes
			_.mapObject(shortenedHTML, (short, tag) => {
				clean = clean.replace(new RegExp(tag, 'g'), short);
			});
		
			const chunks = clean.trim().match(/.{1,1595}/g).slice(0, 2);  // Divide HTML into the max sized SMS - 5
			chunks.map((chunk, index) => {
				twilioClient.messages.create({
					body: `${index+1}/${chunks.length} ${chunk}`,
					from: process.env.TWILIO_NUMBER,
					to: req.body.From,
				});
			});
		} catch(error) {
			twilioClient.messages.create({
				body: `Sorry, something went wrong! Here's the error: ${error}`,
				from: process.env.TWILIO_NUMBER,
				to: req.body.From,
			});
		}

		res.send(clean);
	});
});

app.listen(process.env.PORT || '8081');

exports = module.exports = app;
