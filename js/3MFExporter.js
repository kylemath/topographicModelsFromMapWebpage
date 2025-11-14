import {
	BufferGeometry,
	Color,
	Matrix4,
	Mesh,
	Vector3
} from 'three';

/**
 * @author / https://github.com/flybyray
 * @author / https://github.com/msfeldstein
 */

class _3MFExporter {

	parse( object, onDone, options ) {

		const geometryMap = new Map();
		const materialMap = new Map();
		const textureMap = new Map();
		const colorMap = new Map();

		//

		function processGeometry( geometry ) {

			if ( geometryMap.has( geometry ) ) return;

			//

			const bufferGeometry = new BufferGeometry();

			if ( geometry.isGeometry === true ) {

				bufferGeometry.fromGeometry( geometry );

			} else {

				bufferGeometry.copy( geometry );

			}

			if ( bufferGeometry.isBufferGeometry !== true ) {

				throw new Error( 'THREE.3MFExporter: Geometry is not of type THREE.BufferGeometry.' );

			}

			const vertexPositions = bufferGeometry.getAttribute( 'position' );
			const vertexColors = bufferGeometry.getAttribute( 'color' );

			if ( vertexPositions === undefined ) {

				throw new Error( 'THREE.3MFExporter: Geometry must have a position attribute.' );

			}

			geometryMap.set( geometry, {
				vertex: vertexPositions,
				color: vertexColors
			} );

		}

		function processMaterial( material ) {

			if ( materialMap.has( material ) ) return;

			//

			const a = Math.round( material.opacity * 255 );
			const c = material.color.clone();

			if ( material.vertexColors ) {

				c.set( 0xffffff );

			}

			const sRGB = c.getHexString().toUpperCase();

			materialMap.set( material, {
				name: material.name,
				color: '#' + sRGB + ( ( a < 255 ) ? a.toString( 16 ).toUpperCase() : '' ),
				opacity: material.opacity
			} );

		}

		function processTexture( texture ) {

			if ( textureMap.has( texture ) ) return;

			//

			textureMap.set( texture, {
				image: texture.image
			} );

		}

		function processObject( object ) {

			if ( object.isMesh !== true ) return;

			const geometry = object.geometry;
			const material = object.material;
			const matrix = object.matrixWorld;

			//

			if ( Array.isArray( material ) ) {

				for ( var i = 0, l = material.length; i < l; i ++ ) {

					processMaterial( material[ i ] );

				}

			} else {

				processMaterial( material );

			}

			if ( material.map ) processTexture( material.map );

			processGeometry( geometry );

			//

			for ( let i = 0, l = object.children.length; i < l; i ++ ) {

				processObject( object.children[ i ] );

			}

		}

		processObject( object );

		//

		const xml = buildXML(
			geometryMap,
			materialMap,
			textureMap,
			object.matrixWorld
		);

		onDone( xml );

	}

}

function buildXML( geometryMap, materialMap, textureMap, matrix ) {

	const
		materials = [],
		textures = [],
		geometries = [],
		objects = [];

	materialMap.forEach( function ( material, key ) {

		materials.push( buildMaterial( materials.length, material.name, material.color ) );

	} );

	textureMap.forEach( function ( texture, key ) {

		textures.push( buildTexture( textures.length, texture ) );

	} );

	geometryMap.forEach( function ( geometry, key ) {

		geometries.push( buildGeometry(
			geometries.length,
			geometry,
			materialMap.size > 0 ? Array.from( materialMap.keys() ) : null,
			textureMap.size > 0 ? Array.from( textureMap.keys() ) : null
		) );

	} );

	const worldMatrix = new Matrix4();

	function buildObject( object, index ) {

		const
			mesh = new Mesh( object.geometry, object.material ),
			matrix = object.matrix.clone();

		matrix.premultiply( worldMatrix );

		const
			geometry = object.geometry,
			material = object.material;

		const
			geometryKey = Array.from( geometryMap.keys() ).indexOf( geometry ),
			materialKey = material ? ( Array.isArray( material ) ? null : Array.from( materialMap.keys() ).indexOf( material ) ) : - 1;

		var
			objectXML = '\t\t<object id="' + index + '" type="model" ' + ( materialKey > - 1 ? 'pid="' + materialKey + '"' : '' ) + '>\n' +
				'\t\t\t<mesh>\n' +
					'\t\t\t\t<vertices>\n' +
						geometries[ geometryKey ] +
					'\t\t\t\t</vertices>\n' +
					'\t\t\t\t<triangles>\n' +
					'\t\t\t\t</triangles>\n' +
				'\t\t\t</mesh>\n' +
			'\t\t</object>\n';

		worldMatrix.multiply( matrix );

		for ( let i = 0, l = object.children.length; i < l; i ++ ) {

			const child = object.children[ i ];

			if ( child.isMesh ) {

				objectXML += buildObject( child, i );

			}

		}

		return objectXML;

	}

	const object = buildObject( new Mesh(), 0 );

	var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
			'\t<resources>\n' +
				materials.join( '\n' ) +
				textures.join( '\n' ) +
			'\t</resources>\n' +
			'\t<build>\n' +
				'\t\t<item objectid="0" transform="' + matrix.elements.join( ' ' ) + '"/>\n' +
			'\t</build>\n' +
			'\t<objects>\n' +
				geometries.join( '\n' ) +
			'\t</objects>\n' +
		'</model>';

	return new Blob( [ xml ], { type: 'application/zip' } );

}

function buildMaterial( index, name, color ) {

	return '\t\t<material id="' + index + '" name="' + name + '">\n' +
		'\t\t\t<color color="' + color + '"/>\n' +
	'\t\t</material>\n';

}

function buildTexture( index, texture ) {

	const
		canvas = document.createElement( 'canvas' ),
		ctx = canvas.getContext( '2d' );

	canvas.width = texture.image.width;
	canvas.height = texture.image.height;

	ctx.drawImage( texture.image, 0, 0 );

	//

	const
		path = '/' + index + '.png',
		data = canvas.toDataURL( 'image/png' ).replace( /^data:image\/(png|jpg);base64,/, '' );

	//

	return '\t\t<texture2d id="' + index + '" path="' + path + '" contenttype="image/png" />\n' +
		'\t\t<resource realpath="' + path + '">' + data + '</resource>\n';

}

function buildGeometry( index, geometry, materials, textures ) {

	const
		vertices = geometry.vertex,
		colors = geometry.color;

	const
		vertexCount = vertices.count;

	var
		xml = '\t\t<object id="' + index + '" type="model">\n' +
			'\t\t\t<mesh>\n' +
				'\t\t\t\t<vertices>\n';

	for ( let i = 0; i < vertexCount; i ++ ) {

		const
			vertex = new Vector3().fromBufferAttribute( vertices, i ),
			color = colors ? new Color().fromBufferAttribute( colors, i ) : null;

		xml += '\t\t\t\t\t<vertex x="' + vertex.x + '" y="' + vertex.y + '" z="' + vertex.z + '"' + ( color ? ' color="#' + color.getHexString() + '"' : '' ) + '/>\n';

	}

	xml += '\t\t\t\t</vertices>\n' +
		'\t\t\t\t<triangles>\n';

	for ( let i = 0; i < vertexCount; i += 3 ) {

		xml += '\t\t\t\t\t<triangle v1="' + i + '" v2="' + ( i + 1 ) + '" v3="' + ( i + 2 ) + '"/>\n';

	}

	xml += '\t\t\t\t</triangles>\n' +
		'\t\t\t</mesh>\n' +
	'\t\t</object>\n';

	return xml;

}

export { _3MFExporter };